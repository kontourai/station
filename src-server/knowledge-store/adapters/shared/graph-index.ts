/**
 * Graph index (store-contract.md §5) — a derived cache mirroring every record's own
 * `links` array for O(1) forward/reverse lookup. Persisted at `<storeRoot>/graph-index.json`
 * per §9. Shared by both Station-owned Kit-format adapters.
 */
import type { KitLink } from '@kontourai/station-contracts/knowledge-store';
import { KnowledgeStoreCorruptionError } from '../../errors.js';

export const GRAPH_SCHEMA_VERSION = '1.0';

export interface GraphIndex {
  schema_version: string;
  forward: Record<string, KitLink[]>;
  reverse: Record<string, Array<{ source_id: string; kind: string }>>;
}

export function emptyGraph(): GraphIndex {
  return { schema_version: GRAPH_SCHEMA_VERSION, forward: {}, reverse: {} };
}

/** Strict runtime validation for the derived graph cache. */
export function assertGraphIndex(value: unknown, source: string): GraphIndex {
  const invalid = (detail: string): never => {
    throw new KnowledgeStoreCorruptionError(`${source}: ${detail}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('graph index must be an object');
  }
  const graph = value as Partial<GraphIndex>;
  if (
    graph.schema_version !== GRAPH_SCHEMA_VERSION ||
    !graph.forward ||
    typeof graph.forward !== 'object' ||
    Array.isArray(graph.forward) ||
    !graph.reverse ||
    typeof graph.reverse !== 'object' ||
    Array.isArray(graph.reverse)
  ) {
    invalid('graph index has an unsupported shape');
  }
  for (const links of Object.values(
    graph.forward as Record<string, KitLink[]>,
  )) {
    if (
      !Array.isArray(links) ||
      links.some(
        (link) =>
          !link ||
          typeof link !== 'object' ||
          typeof link.target_id !== 'string' ||
          typeof link.kind !== 'string' ||
          (link.label !== undefined && typeof link.label !== 'string'),
      )
    ) {
      invalid('graph forward links are invalid');
    }
  }
  for (const links of Object.values(
    graph.reverse as Record<string, Array<{ source_id: string; kind: string }>>,
  )) {
    if (
      !Array.isArray(links) ||
      links.some(
        (link) =>
          !link ||
          typeof link !== 'object' ||
          typeof link.source_id !== 'string' ||
          typeof link.kind !== 'string',
      )
    ) {
      invalid('graph reverse links are invalid');
    }
  }
  return graph as GraphIndex;
}

export function addLinksToGraph(
  graph: GraphIndex,
  sourceId: string,
  links: KitLink[],
): void {
  if (!graph.forward[sourceId]) graph.forward[sourceId] = [];
  for (const link of links) {
    const { target_id, kind, label } = link;
    const exists = graph.forward[sourceId].some(
      (l) => l.target_id === target_id && l.kind === kind,
    );
    if (!exists) {
      const entry: KitLink = label
        ? { target_id, kind, label }
        : { target_id, kind };
      graph.forward[sourceId].push(entry);
      if (!graph.reverse[target_id]) graph.reverse[target_id] = [];
      graph.reverse[target_id].push({ source_id: sourceId, kind });
    }
  }
}

export function removeLinksFromGraph(
  graph: GraphIndex,
  sourceId: string,
): void {
  const oldForward = graph.forward[sourceId] || [];
  for (const link of oldForward) {
    const rev = graph.reverse[link.target_id] || [];
    graph.reverse[link.target_id] = rev.filter((r) => r.source_id !== sourceId);
    if (graph.reverse[link.target_id].length === 0)
      delete graph.reverse[link.target_id];
  }
  delete graph.forward[sourceId];
}

/** Order-independent canonical form of a graph index, for drift comparison (§5.2 `changed`). */
export function canonicalGraph(graph: GraphIndex): string {
  const norm = (obj: Record<string, unknown[]>) =>
    Object.keys(obj || {})
      .sort()
      .reduce<Record<string, string[]>>((acc, k) => {
        acc[k] = (obj[k] || []).map((e) => JSON.stringify(e)).sort();
        return acc;
      }, {});
  return JSON.stringify({
    forward: norm(graph.forward),
    reverse: norm(graph.reverse),
  });
}

/** Result shape for an adapter's optional `reindex()` recovery op (store-contract.md §5.2). */
export interface ReindexResult {
  records: number;
  links: number;
  forwardSources: number;
  reverseTargets: number;
  changed: boolean;
}
