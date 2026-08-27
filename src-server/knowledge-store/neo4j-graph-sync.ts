/**
 * Neo4j graph-sync — idempotent projection of a root's records+links into Neo4j.
 * Resolves the Q1 verdict recorded in `s203-knowledge-meeting-notes--plan.md` /
 * ratified in `s203-knowledge-meeting-notes--pull-work.md` ("Graph view, synced"):
 * a personal root's storage stays on a real file adapter (`kit-default-store`/
 * `kit-obsidian-store`); Neo4j is a read-side materialized graph view SYNCED FROM
 * that adapter, never a write target of its own (see `./neo4j-connection.ts`'s
 * module doc for the full K2 architecture citation). This module owns the one
 * direction of that sync: file adapter -> Neo4j.
 *
 * This mirrors the *behavior* the Kit's own published `sync.js` documents (content-
 * hash-guarded MERGE, per ADR-0009) as a spec reference only — nothing here imports
 * `@kontourai/flow-agents` internals; the `knowledge-kit-import-gate.mjs` zero-
 * tolerance gate enforces that boundary repo-wide, and this module's only inputs
 * are the public `KnowledgeStoreProvider`/`KnowledgeStoreAdapter` contract
 * (`packages/contracts/src/knowledge-store.ts`) and a `Neo4jDriverLike` (real or
 * fake — `./neo4j-graph-provider.ts`).
 *
 * Idempotency (this file's core acceptance criterion): each record projects to a
 * `(:KitRecord {rootId, recordId})` node carrying only the fields the graph view
 * actually needs — `type`/`title`/`category` (the plan's own node-shape decision;
 * record `body` is deliberately NOT projected, so a body-only edit doesn't dirty
 * the synced node) — plus a content hash of exactly those projected fields. Before
 * writing, this module reads back the node's currently-stored hash and skips the
 * write entirely when it already matches, so re-running `syncRootToNeo4j` against
 * an unchanged store issues zero `MERGE`/`SET` write calls on the second pass. Same
 * guard for each forward link, projected to a `(:KitRecord)-[:LINKS_TO {kind}]
 * ->(:KitRecord)` edge hashed over `{source, target, kind, label}`.
 *
 * Two-pass sync (fixes a code-review HIGH finding, `s203-knowledge-meeting-notes
 * --code-review.md`): `records` is a single flat array collected across every
 * `KitRecordType` in `ALL_KIT_RECORD_TYPES` order, and nothing about that order
 * is a same-type or cross-type dependency guarantee for a record's own links. A
 * single interleaved pass (merge a record's node, then immediately its outgoing
 * edges, before moving to the next record) makes an edge's success depend on
 * whether its TARGET happened to already be visited earlier in the same pass —
 * `mergeEdge`'s `MATCH (s...),(t...) MERGE ...` silently produces zero rows (no
 * throw) when either match fails, so a forward-reference edge (e.g. a `raw`
 * record linking to a `compiled` record that sorts later in the array, or any
 * same-type link to a not-yet-visited sibling) would silently never be created
 * while `stats.linksWritten` still counted it. This module instead runs two full
 * passes over `records`: first every node (so every record in `knownIds` is
 * guaranteed present in Neo4j — either already there, or freshly merged — by the
 * time ANY edge is processed), then every edge. This removes the ordering
 * dependency entirely and keeps `stats.linksWritten`/`linksSkippedDangling`
 * honest: a link only reaches `mergeEdge` once its target has passed the
 * `knownIds` dangling check, and by pass two every `knownIds` member's node is
 * guaranteed to already exist, so `mergeEdge`'s `MATCH` can never silently no-op
 * for a link this module chose to write.
 *
 * Scope boundary (Q1 verdict, deliberately NOT built here): no deletion/orphan
 * pruning of nodes/edges whose source record was removed from the file store since
 * the last sync (an accepted, named gap — same "additive projection only" scope
 * `./neo4j-graph-provider.ts`'s doc comment names for the read side's four
 * deferred structural queries). A dangling link — a `target_id` that isn't itself
 * among the root's own enumerated records — is skipped and counted, never written
 * as an edge to a node that doesn't exist; same "never silently invent success"
 * honesty bar the rest of this store package already holds.
 *
 * Performance (named-deferred, per a code-review MEDIUM finding — not scoped out
 * of this doc comment the way the pruning gap above is, but flagged the same
 * way): each record issues up to 2 sequential `session.run` round-trips (a hash
 * read, then a conditional write) and each link the same, none batched into a
 * single Cypher statement or `Promise.all`'d. Fine at this demo's scale; a future
 * caller syncing a much larger root should batch (e.g. `UNWIND` over a list
 * parameter) rather than assume this stays cheap.
 */
import { createHash } from 'node:crypto';
import type {
  KitRecordType,
  KnowledgeStoreProvider,
} from '@kontourai/station-contracts/knowledge-store';
import type { Neo4jDriverLike } from './neo4j-graph-provider.js';

/** All `KitRecordType`s — mirrors `knowledge-record-routes.ts`'s own
 * `ALL_KIT_RECORD_TYPES` constant (not exported there, so kept in sync by hand,
 * same convention that file itself already follows for `sqlite-vec-index-
 * provider.ts`'s un-exported original). */
const ALL_KIT_RECORD_TYPES: KitRecordType[] = [
  'raw',
  'compiled',
  'concept',
  'snapshot',
  'person',
];

export const NEO4J_SYNC_QUERIES = {
  getNodeHash:
    'MATCH (n:KitRecord {rootId: $rootId, recordId: $id}) ' +
    'RETURN n.contentHash AS contentHash',
  mergeNode:
    'MERGE (n:KitRecord {rootId: $rootId, recordId: $id}) ' +
    'SET n.type = $type, n.title = $title, n.category = $category, ' +
    'n.contentHash = $contentHash, n.syncedAt = $syncedAt',
  getEdgeHash:
    'MATCH (s:KitRecord {rootId: $rootId, recordId: $sourceId})' +
    '-[r:LINKS_TO {kind: $kind}]->' +
    '(t:KitRecord {rootId: $rootId, recordId: $targetId}) ' +
    'RETURN r.contentHash AS contentHash',
  mergeEdge:
    'MATCH (s:KitRecord {rootId: $rootId, recordId: $sourceId}), ' +
    '(t:KitRecord {rootId: $rootId, recordId: $targetId}) ' +
    'MERGE (s)-[r:LINKS_TO {kind: $kind}]->(t) ' +
    'SET r.label = $label, r.contentHash = $contentHash',
} as const;

export interface SyncStats {
  rootId: string;
  recordsScanned: number;
  linksScanned: number;
  nodesWritten: number;
  nodesUnchanged: number;
  linksWritten: number;
  linksUnchanged: number;
  linksSkippedDangling: number;
}

export interface SyncOptions {
  rootId: string;
  store: KnowledgeStoreProvider;
  driver: Neo4jDriverLike;
  database?: string;
}

function hashNode(fields: {
  id: string;
  type: string;
  title: string;
  category: string;
}): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function hashEdge(fields: {
  source: string;
  target: string;
  kind: string;
  label?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...fields, label: fields.label ?? null }))
    .digest('hex');
}

function firstValue(
  records: Array<{ get(key: string): unknown }>,
  key: string,
): unknown {
  return records.length > 0 ? records[0].get(key) : undefined;
}

/**
 * Enumerates `rootId`'s records (every `KitRecordType`) via its registered
 * `KnowledgeStoreAdapter`, and idempotently projects each record + forward link
 * into Neo4j through `driver`. Never mutates the file-adapter store itself — reads
 * only (`listByType`). Two-pass (see module doc): every node first, then every
 * edge, so an edge's target node is always already present by the time the edge
 * is processed, regardless of `ALL_KIT_RECORD_TYPES`/creation order.
 */
export async function syncRootToNeo4j(
  options: SyncOptions,
): Promise<SyncStats> {
  const { rootId, store, driver, database } = options;
  const session = driver.session({ database });
  const stats: SyncStats = {
    rootId,
    recordsScanned: 0,
    linksScanned: 0,
    nodesWritten: 0,
    nodesUnchanged: 0,
    linksWritten: 0,
    linksUnchanged: 0,
    linksSkippedDangling: 0,
  };

  try {
    const adapter = await store.adapterFor(rootId);
    const records = [];
    for (const type of ALL_KIT_RECORD_TYPES) {
      records.push(...(await adapter.listByType(type)));
    }
    stats.recordsScanned = records.length;
    const knownIds = new Set(records.map((r) => r.id));

    // Pass 1: merge every record's own node first, across every type in
    // `records`, before any edge is processed. By the end of this pass, every
    // id in `knownIds` is guaranteed to already exist as a node in Neo4j (it
    // was either already there with a matching hash, or freshly merged here)
    // — no edge in pass 2 can ever be blocked by an order-dependent missing
    // target.
    for (const record of records) {
      const contentHash = hashNode({
        id: record.id,
        type: record.type,
        title: record.title,
        category: record.category,
      });
      const existing = await session.run(NEO4J_SYNC_QUERIES.getNodeHash, {
        rootId,
        id: record.id,
      });
      const existingHash = firstValue(existing.records, 'contentHash');
      if (existingHash === contentHash) {
        stats.nodesUnchanged += 1;
      } else {
        await session.run(NEO4J_SYNC_QUERIES.mergeNode, {
          rootId,
          id: record.id,
          type: record.type,
          title: record.title,
          category: record.category,
          contentHash,
          syncedAt: new Date().toISOString(),
        });
        stats.nodesWritten += 1;
      }
    }

    // Pass 2: merge every forward link now that every non-dangling target's
    // node is guaranteed to already exist (pass 1, above) — `mergeEdge`'s
    // `MATCH (s...),(t...)` can no longer silently no-op for a link this loop
    // chooses to write, so `stats.linksWritten` stays honest.
    for (const record of records) {
      for (const link of record.links ?? []) {
        stats.linksScanned += 1;
        if (!knownIds.has(link.target_id)) {
          stats.linksSkippedDangling += 1;
          continue;
        }
        const edgeHash = hashEdge({
          source: record.id,
          target: link.target_id,
          kind: link.kind,
          label: link.label,
        });
        const existingEdge = await session.run(NEO4J_SYNC_QUERIES.getEdgeHash, {
          rootId,
          sourceId: record.id,
          targetId: link.target_id,
          kind: link.kind,
        });
        const existingEdgeHash = firstValue(
          existingEdge.records,
          'contentHash',
        );
        if (existingEdgeHash === edgeHash) {
          stats.linksUnchanged += 1;
        } else {
          await session.run(NEO4J_SYNC_QUERIES.mergeEdge, {
            rootId,
            sourceId: record.id,
            targetId: link.target_id,
            kind: link.kind,
            label: link.label ?? null,
            contentHash: edgeHash,
          });
          stats.linksWritten += 1;
        }
      }
    }

    return stats;
  } finally {
    await session.close();
  }
}
