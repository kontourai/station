# Treat knowledge stores as canonical and the index as derived

## Context

Station's knowledge system conflates storage and retrieval into one seam: `KnowledgeService` writes document metadata/content to a per-project directory tree and embeds chunks into a single globally-resolved `IVectorDbProvider` — `resolveRuntimeVectorDbProvider` picks the **one** enabled `vectordb`-capability connection (`findRuntimeCapabilityConnection(providerService, 'vectordb')`, `src-server/runtime/plugins/runtime-provider-resolution.ts:91-99`), partitioned only by a namespace string (`project-<slug>` / `project-<slug>:<namespace>`, `knowledgeVectorNamespace()`). There is no per-store adapter selection and no personal tier — only per-project namespaces. The built-in "LanceDB" provider is not the LanceDB library: `src-server/providers/lancedb-provider.ts` (`id: 'lancedb-file'`, lines 42–113) is a hand-rolled flat-JSON-file store with a brute-force cosine-similarity scan — the vector data it holds is the only place the knowledge lives in retrievable form, so today the *index is the store*. The user never chose this deliberately ("Lance was free so I stuffed it in there") and decided on 2026-07-05 to replace it outright via an evidence matrix. Meanwhile the Flow Agents Knowledge Kit publishes a store contract (`kits/knowledge/docs/store-contract.md`, shipped inside the `@kontourai/flow-agents` package) with portable markdown-frontmatter records, typed links, provenance, supersede-not-delete lifecycle, and a `KnowledgeStoreAdapter` interface (§8, constructor `{ storeRoot }`) with peer adapters (default-file, Obsidian) — and explicitly parks vector/semantic retrieval as a non-goal (Kit README "Non-Goals", I10). Per ADR-0001, Station consumes the Kit only through this published contract — file format, CLI/flows, documented interfaces — never internals.

## Decision

Knowledge is split into two layers with an explicit authority ranking. **Layer 1 — canonical stores:** Kit-format, adapter-backed store roots become the sole source of truth for knowledge records. Station reads and writes them only through the Kit's published `KnowledgeStoreAdapter` contract (`create`/`update`/`link`/`supersede`/`retire`/`get`/`getLinks`/`listByCategory`/`listByType`, store-contract.md §8 + Addenda A.6/B.5) and its on-disk file format — human-readable, portable, and owned by the user, not by Station's runtime. **Layer 2 — derived index:** the retrieval index (successor chosen in the appendix: **sqlite-vec**) is demoted to a derived, disposable, rebuildable cache behind a provider seam analogous to today's `IVectorDbProvider`/`IEmbeddingProvider`. It may be deleted at any time and rebuilt from Layer 1 with no information loss; it is never written to except as a projection of store records, and never treated as a second source of truth. **Scoping:** store roots come in two tiers — one personal root per user, plus per-project roots (today's per-project namespaces generalize into project roots); an org tier is explicitly deferred pending multi-user evidence. This is built on the Kit's real published surface — `storeRoot` constructor argument plus the adapter/provider split — not on a "knowledge roots" contract, because no such upstream contract exists (exhaustively verified during shaping; see `.kontourai/flow-agents/knowledge-foundation/knowledge-foundation--idea-to-backlog.md`, Evidence note). The Kit's Neo4j provider is *not* the retrieval index: it is a structural graph materialized view (blocker closure, contradiction candidates, orphans, duplicates, shortest path) synced from file stores, and it stays on the store/provider axis (K2 adapter surface, K5 dual-adapter dogfood), outside this index seam — see the appendix caveat.

Provenance: User decision, 2026-07-05 — replace LanceDB outright via this matrix; foundation first (notes app is the validator); dual-adapter dogfood (Obsidian and Neo4j personal roots) as a program requirement.

## Consequences

Multiple simultaneous stores become natural (personal + N project roots served by one index with a store partition key) instead of impossible — but this is the *target* state; today's single-global-connection reality remains until K2/K3 land. Existing project knowledge must migrate non-destructively: old `{dataDir}/vectordb/<namespace>/vectors.json` and `{dataDir}/projects/<slug>/knowledge/<namespace>/` directories are preserved untouched until an explicit user-confirmed cutover (migration sketch in `docs/design/knowledge-foundation.md`). Rebuildability becomes the safety property K3 must test (index deleted → rebuilt → same recall). The K2 store seam and K3 index seam are specified as named TypeScript contracts in `docs/design/knowledge-foundation.md`; K2 is buildable from that doc plus this ADR alone. Because the index is disposable, the pre-1.0 maturity risk of the chosen index library is contained: swapping it later is an index rebuild, not a data migration.

---

## Appendix — Retrieval-index evaluation matrix and recommendation

Four candidates were evaluated against six criteria. Two hands-on probes (sqlite-vec, real LanceDB) were run on 2026-07-05 in this session's scratchpad (`<scratchpad>/knowledge-probe-sqlite-vec/`, `<scratchpad>/knowledge-probe-lancedb/` — outside both repo checkouts; neither repo's dependency tree was touched, `git status` clean in both afterward). Full transcripts are reproduced below since the scratchpad is not part of repo history. Probes used a 50-chunk fixture corpus (5 topics × 10 records shaped like Kit `compiled`/`concept` records) embedded with real `nomic-embed-text` via ollama — the Kit's own documented vector-detector path (Kit README, "Vector detector — ollama embedding").

> **Different-axis caveat (Neo4j view).** The Kit's `providers/neo4j` is a structural graph **materialized view** — `transitiveBlockers`, `contradictionCandidates`, `orphans`, `duplicateCandidates`, `shortestPath` — synced idempotently from the file providers, degrading to them when no Neo4j is reachable (Kit README, "Graph provider (opt-in)"). It answers *structural* questions, not embedding-similarity topK retrieval. Scoring it on identical criteria would compare different capabilities, so its cells below carry qualifying notes instead of being force-normalized. Its real role in this program is on the store/adapter axis (K2 surfaces it; K5 dogfoods it), not as the index.

### Matrix

| Criterion | sqlite-vec | pgvector | LanceDB (real, as adapter) | Kit Neo4j view |
|---|---|---|---|---|
| Embedded / zero-service default | **Yes.** In-process SQLite loadable extension; probe loaded it into Node's built-in `node:sqlite` (Node 24), no daemon. [Probe A; github.com/asg017/sqlite-vec README] | **No.** Postgres extension — requires a running Postgres server. [github.com/pgvector/pgvector README: "Open-source vector similarity search for Postgres"] | **Yes.** Embedded, file-backed; probe connected via `lancedb.connect('./lancedb-data')`, no daemon. [Probe B; lancedb.com docs] | **No.** Requires a Neo4j daemon (Docker in the Kit's own docs); degrades to file providers without it. *Different axis: structural graph, not vector retrieval.* [Kit README "Graph provider (opt-in)" §1] |
| License + branding | Dual **MIT OR Apache-2.0** (npm `sqlite-vec@0.1.9` license field; `LICENSE-MIT` + `LICENSE-APACHE` in repo). Rebranding permitted with attribution. | Extension: **PostgreSQL License** (repo `LICENSE` — permissive BSD-style); npm client `pgvector@0.3.0`: MIT. Rebranding permitted. | **Apache-2.0** (npm `@lancedb/lancedb@0.31.0`). Rebranding permitted with attribution; "LanceDB" name is the vendor's mark — today's `lancedb-file` id misuses it (names a library not actually used) and is retired either way. | Kit provider + `neo4j-driver`: **Apache-2.0** (flow-agents `LICENSE`; npm `neo4j-driver`). Neo4j Community **server** is GPLv3 (`github.com/neo4j/neo4j` `LICENSE.txt`, verified at tag `2026.05`) — external process, no linkage into Station, but it cannot ship as a bundled default. |
| Multi-store indexing | **Strong.** `vec0` virtual tables support a `partition key` column; probe served personal + project stores from one table with zero cross-store leakage in scoped queries. [Probe A] | **Yes.** Tables/schemas per store + `WHERE` predicates — standard SQL; unprobed (service-gated). [pgvector README, filtering section] | **Yes.** Table-per-store or metadata filter; probe used `.where("store = '...'")` with zero leakage. [Probe B] | **Multi-source by design** — `sync` merges several providers into one graph — but it serves structural queries over the merged graph, not per-store similarity retrieval. [Kit README §3] |
| Rebuild-from-store cost | Embed-and-insert pass per record; no built-in reindex-from-files primitive — **symmetric across all three vector candidates**. Probe: 50 chunks = 461ms embed (ollama-bound) + **2.1ms** insert. [Probe A] | Same symmetric embed+insert pass; plus Postgres must be up before any rebuild. [pgvector docs] | Same symmetric pass. Probe: 50 chunks = 316ms embed + **31.3ms** createTable+insert. [Probe B] | Has a real idempotent `sync` with a content-hash guard (re-sync of unchanged stores = zero writes) — but it rebuilds a structural graph, not embeddings; not comparable as an index rebuild. [Kit README §3] |
| Migration effort from existing LanceDB data | **Low.** Source is a flat JSON array of `{id, vector, text, metadata}` per namespace (`lancedb-provider.ts:28-32`) — read directly; target schema is one `CREATE VIRTUAL TABLE` + inserts (probe's whole schema was 8 lines); existing vectors reusable as-is when the embedding provider is unchanged. [Probe A] | Low on the data side (same trivial source), but requires provisioning Postgres first — a migration prerequisite the user must operate. | **Low.** `createTable(rows)` directly from the parsed JSON. [Probe B] | **N/A** — does not ingest vectors; the old vector data has no meaning to it. |
| Node/npm ecosystem maturity | Prebuilt platform binaries, **2 packages / 192KB** installed in **0.6s**; works with built-in `node:sqlite` (zero further native deps) or `better-sqlite3`. 1,895,240 npm downloads/week (2026-06-28..07-04); recommended/adopted version `0.1.9` (the `latest` dist-tag, and the version the probe pinned) last published 2026-03-31 (`npm view sqlite-vec@0.1.9 time`) — a `0.1.10-alpha.4` pre-release exists dated 2026-05-18 but is not installed or recommended anywhere in this ADR. **Caveat: pre-1.0 (v0.1.9)**, over three months stale relative to this session (2026-07-05) — contained by the index being disposable/rebuildable. | Extension itself is mature and very widely deployed (managed-Postgres vendors ship it); npm client thin (356,357/week; 2026-05-31). Maturity is high but it is server-ecosystem maturity, not embedded-Node. | Company-backed, actively released (0.31.0 published 2026-07-02; 748,155/week). **Heavy:** probe install pulled **109 packages / 480MB in 8.2s** including `onnxruntime-node`, `sharp`, `protobufjs` install scripts. [Probe B `install.log`] | `neo4j-driver` mature (542,711/week; 2026-06-30) — but driver maturity is moot for the index role; the server dependency decides. |

### Recommendation

**Winner: sqlite-vec** (dual MIT/Apache-2.0), loaded into Node's built-in `node:sqlite`. It is the only candidate that wins the origin-story criterion outright — a true in-process, zero-service, zero-config default (the probe ran against `:memory:`/single-file DBs with an 8-line schema) — while being ~2500x lighter to install than the runner-up (192KB vs 480MB), the fastest in the probe (0.3–0.95ms queries, 2.1ms bulk insert at 50 chunks), and the only one whose native partition-key feature maps one-to-one onto the personal-root + project-roots scoping model. Its one real weakness, pre-1.0 versioning, is structurally contained by this ADR's core decision: the index is derived and disposable, so replacing sqlite-vec later costs a rebuild, not a migration. Retrieval quality was identical to the runner-up in the probe (same embeddings, same cosine distances, same rankings: expected records at rank 1/1/2 across the three test queries).

**Runner-up: real LanceDB as one adapter** (`@lancedb/lancedb`, Apache-2.0). Also embedded and zero-service, company-backed, columnar and scale-ready, with identical probe retrieval results — but its 109-package/480MB dependency tree (with three native install-script packages) is disproportionate for Station's default, and its scale advantages only matter far beyond a personal knowledge base's corpus size. Because K3's index sits behind a provider seam, real LanceDB remains available later as an *optional* index adapter without revisiting this decision — an honest use of the name, unlike today's `lancedb-file`.

Not recommended for the default: **pgvector** — fails the embedded/zero-service criterion that the replacement decision exists to fix (needs a running Postgres); it remains a plausible future optional adapter for server deployments. **Kit Neo4j view** — not scored as an index; it answers structural questions on a different axis and enters the program through K2's adapter/provider surface and K5's dual-adapter dogfood instead.

### Probe A — sqlite-vec (transcript, run 2026-07-05, scratchpad `knowledge-probe-sqlite-vec/`)

Install (`install.log`): `npm install sqlite-vec@0.1.9` → "added 2 packages, and audited 3 packages in 462ms … 0.59 real". `node_modules`: 192KB.

```text
$ node probe.mjs
embedding path: ollama nomic-embed-text (real embeddings, 768 dims)
corpus: 50 chunks across 5 categories
sqlite-vec extension loaded: vec_version=v0.1.9 (loadable path: .../node_modules/sqlite-vec-darwin-arm64/vec0.dylib)
ingest: embed 50 chunks 461ms, insert 2.1ms

QUERY (0.95ms): How do I keep my sourdough starter alive and get a sour flavor?
  rec-011  d=0.1630  [cooking.baking] Sourdough starter maintenance
  rec-014  d=0.3812  [cooking.baking] Proofing temperature control
  rec-016  d=0.3957  [cooking.baking] Enriched dough basics
  rec-019  d=0.4192  [cooking.baking] Pastry cream thickening
  rec-017  d=0.4200  [cooking.baking] Baking with steam
  expected rec-011 rank: 1; top category OK

QUERY (0.40ms): What is the tradeoff between HNSW and IVF for nearest neighbor search?
  rec-001  d=0.2898  [engineering.database] Vector index tradeoffs
  rec-010  d=0.3759  [engineering.database] Metadata filtering in vector search
  rec-005  d=0.4091  [engineering.database] Columnar storage formats
  rec-007  d=0.4169  [engineering.database] Cosine similarity scoring
  rec-009  d=0.4199  [engineering.database] Brute-force scan limits
  expected rec-001 rank: 1; top category OK

QUERY (0.41ms): Why should the retrieval index be rebuildable from canonical records?
  rec-008  d=0.2343  [engineering.database] Index rebuild strategies
  rec-041  d=0.3071  [product.knowledge-tools] Two-layer knowledge architecture
  rec-050  d=0.3357  [product.knowledge-tools] Rebuildable index safety
  rec-045  d=0.3938  [product.knowledge-tools] Supersede instead of delete
  rec-001  d=0.4288  [engineering.database] Vector index tradeoffs
  expected rec-041 rank: 2; top category WRONG

SCOPED QUERY store=root:project-station (0.30ms):
  rec-050  d=0.3469  [product.knowledge-tools] Rebuildable index safety
  rec-041  d=0.3550  [product.knowledge-tools] Two-layer knowledge architecture
  rec-042  d=0.4983  [product.knowledge-tools] Wikilink graphs for recall
  all results project-scoped: OK
```

(The third query's "top category WRONG" is a fair semantic result, not an error — `rec-008` "Index rebuild strategies" is genuinely the closest chunk to that question; the expected record still ranked 2nd. Both probes returned the identical ranking.)

Friction observed: none beyond knowing the `node:sqlite` extension-loading incantation (`allowExtension: true` + `enableLoadExtension`) and binding vectors as `Uint8Array` over a `Float32Array` buffer. The `vec0` schema — partition key, metadata columns, auxiliary `+` columns, `distance_metric=cosine` — expressed the whole store-scoping model in one DDL statement.

### Probe B — real LanceDB (transcript, run 2026-07-05, scratchpad `knowledge-probe-lancedb/`)

Install (`install.log`): `npm install @lancedb/lancedb@0.31.0` → "added 109 packages … in 8s … 8.20 real", with install-script warnings for `onnxruntime-node@1.19.2`, `sharp@0.33.5`, `protobufjs@7.6.5`. `node_modules`: 480MB.

```text
$ node probe.mjs
embedding path: ollama nomic-embed-text (real embeddings, 768 dims)
corpus: 50 chunks across 5 categories
connected to ./lancedb-data (embedded, file-backed — no service)
ingest: embed 50 chunks 316ms, createTable+insert 31.3ms, rowCount=50

QUERY (14.00ms): How do I keep my sourdough starter alive and get a sour flavor?
  rec-011  d=0.1630  [cooking.baking] Sourdough starter maintenance
  ... (identical top-5 ranking and cosine distances to Probe A)
  expected rec-011 rank: 1; top category OK

QUERY (2.87ms): What is the tradeoff between HNSW and IVF for nearest neighbor search?
  rec-001  d=0.2898  [engineering.database] Vector index tradeoffs
  ... (identical top-5 to Probe A)
  expected rec-001 rank: 1; top category OK

QUERY (1.82ms): Why should the retrieval index be rebuildable from canonical records?
  rec-008  d=0.2343  [engineering.database] Index rebuild strategies
  rec-041  d=0.3071  [product.knowledge-tools] Two-layer knowledge architecture
  ... (identical top-5 to Probe A)
  expected rec-041 rank: 2; top category WRONG

SCOPED QUERY store=root:project-station (4.91ms):
  rec-050  d=0.3469  [product.knowledge-tools] Rebuildable index safety
  rec-041  d=0.3550  [product.knowledge-tools] Two-layer knowledge architecture
  rec-042  d=0.4983  [product.knowledge-tools] Wikilink graphs for recall
  all results project-scoped: OK
```

Friction observed: heavyweight install (109 packages, three native install scripts flagged by the allow-scripts gate); a WARN log line on first table creation; API otherwise pleasant (`vectorSearch().distanceType('cosine').where(...).limit(n)`).

### Accepted gaps

- pgvector was not hands-on probed (no running Postgres in this environment, and the desk review already failed it on the zero-service criterion) — scored at desk-review depth, per the plan's explicit allowance.
- Store-contract Addenda I (inbound-reference integrity), K (supersede/retire citer propagation), and L (incremental consolidation) were read in full during this spike: all three are read-only record-lifecycle/audit flows over the existing query surface and change nothing in the two-layer storage/retrieval picture.
