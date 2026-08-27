/**
 * Station-owned in-memory Neo4j driver double — NEVER the Kit's own `fake-driver.js`
 * (that file lives past `@kontourai/flow-agents`'s `exports` map and is unimportable
 * per ADR-0009/the `knowledge-kit-import-gate.mjs` gate; this is a from-scratch
 * implementation of the `Neo4jDriverLike` contract, sized to exactly the fixed set
 * of named queries `../neo4j-graph-sync.ts` and `../neo4j-graph-provider.ts` issue —
 * see `NEO4J_SYNC_QUERIES`/`NEO4J_GRAPH_QUERIES`).
 *
 * Dispatches on strict equality against those exported query-string constants
 * (never a substring/regex heuristic over arbitrary Cypher) — robust to those
 * modules' queries changing shape as long as this double's `handleRun` switch is
 * kept in sync, which is the same "hand-rolled, kept in sync" discipline this
 * package's `ALL_KIT_RECORD_TYPES` duplication already accepts elsewhere.
 *
 * Storage is a plain in-memory map of `(rootId, recordId)` -> node and
 * `(rootId, sourceId, targetId, kind)` -> edge, scoped per driver instance (a fresh
 * `new FakeNeo4jDriver()` per test starts empty) — no cross-test leakage.
 */
import {
  NEO4J_GRAPH_QUERIES,
  type Neo4jDriverLike,
  type Neo4jRunResult,
  type Neo4jSessionLike,
} from '../neo4j-graph-provider.js';
import { NEO4J_SYNC_QUERIES } from '../neo4j-graph-sync.js';

interface FakeNode {
  rootId: string;
  id: string;
  type: string;
  title: string;
  category: string;
  contentHash: string;
  syncedAt: string;
}

interface FakeEdge {
  rootId: string;
  source: string;
  target: string;
  kind: string;
  label: string | null;
  contentHash: string;
}

class FakeNeo4jRecord {
  constructor(private readonly data: Record<string, unknown>) {}
  get(key: string): unknown {
    return this.data[key];
  }
}

export interface FakeNeo4jRunCall {
  cypher: string;
  params: Record<string, unknown>;
}

export class FakeNeo4jDriver implements Neo4jDriverLike {
  private readonly nodes = new Map<string, FakeNode>();
  private readonly edges = new Map<string, FakeEdge>();

  /** Every `session().run(...)` call this driver has handled, in order — lets a
   * test assert on raw write-call counts, not just the sync module's own stats. */
  readonly runCalls: FakeNeo4jRunCall[] = [];

  session(_config?: { database?: string }): Neo4jSessionLike {
    return {
      run: async (cypher: string, params: Record<string, unknown> = {}) =>
        this.handleRun(cypher, params),
      close: async () => {},
    };
  }

  async close(): Promise<void> {}

  /** Write-call count across the two mutating queries (`mergeNode`/`mergeEdge`) —
   * the idempotency contract's own observable: unchanged data must issue zero of
   * these on a second sync pass. */
  get writeCallCount(): number {
    return this.runCalls.filter(
      (c) =>
        c.cypher === NEO4J_SYNC_QUERIES.mergeNode ||
        c.cypher === NEO4J_SYNC_QUERIES.mergeEdge,
    ).length;
  }

  private nodeKey(rootId: string, id: string): string {
    return `${rootId}::${id}`;
  }

  private edgeKey(
    rootId: string,
    source: string,
    target: string,
    kind: string,
  ): string {
    return `${rootId}::${source}->${target}::${kind}`;
  }

  private handleRun(
    cypher: string,
    params: Record<string, unknown>,
  ): Neo4jRunResult {
    this.runCalls.push({ cypher, params });

    switch (cypher) {
      case NEO4J_SYNC_QUERIES.getNodeHash: {
        const node = this.nodes.get(
          this.nodeKey(params.rootId as string, params.id as string),
        );
        return {
          records: node
            ? [new FakeNeo4jRecord({ contentHash: node.contentHash })]
            : [],
        };
      }

      case NEO4J_SYNC_QUERIES.mergeNode: {
        const rootId = params.rootId as string;
        const id = params.id as string;
        this.nodes.set(this.nodeKey(rootId, id), {
          rootId,
          id,
          type: params.type as string,
          title: params.title as string,
          category: params.category as string,
          contentHash: params.contentHash as string,
          syncedAt: params.syncedAt as string,
        });
        return { records: [] };
      }

      case NEO4J_SYNC_QUERIES.getEdgeHash: {
        const edge = this.edges.get(
          this.edgeKey(
            params.rootId as string,
            params.sourceId as string,
            params.targetId as string,
            params.kind as string,
          ),
        );
        return {
          records: edge
            ? [new FakeNeo4jRecord({ contentHash: edge.contentHash })]
            : [],
        };
      }

      case NEO4J_SYNC_QUERIES.mergeEdge: {
        const rootId = params.rootId as string;
        const source = params.sourceId as string;
        const target = params.targetId as string;
        const kind = params.kind as string;
        // Honestly mirrors the real query's `MATCH (s...),(t...) MERGE ...`
        // semantics: Cypher's `MATCH` silently matches zero rows (never
        // throws) when either node pattern fails, and a `MERGE` chained after
        // a zero-row `MATCH` creates nothing. If this fake instead created the
        // edge unconditionally, it would mask exactly the order-dependent
        // silent-no-op bug this driver double exists to let tests catch (see
        // `s203-knowledge-meeting-notes--code-review.md`'s HIGH finding).
        const sourceExists = this.nodes.has(this.nodeKey(rootId, source));
        const targetExists = this.nodes.has(this.nodeKey(rootId, target));
        if (!sourceExists || !targetExists) {
          return { records: [] };
        }
        this.edges.set(this.edgeKey(rootId, source, target, kind), {
          rootId,
          source,
          target,
          kind,
          label: (params.label as string | null | undefined) ?? null,
          contentHash: params.contentHash as string,
        });
        return { records: [] };
      }

      case NEO4J_GRAPH_QUERIES.readNodes: {
        const rootId = params.rootId as string;
        const rows = [...this.nodes.values()].filter(
          (n) => n.rootId === rootId,
        );
        return {
          records: rows.map(
            (n) =>
              new FakeNeo4jRecord({
                id: n.id,
                type: n.type,
                title: n.title,
                category: n.category,
              }),
          ),
        };
      }

      case NEO4J_GRAPH_QUERIES.readEdges: {
        const rootId = params.rootId as string;
        const rows = [...this.edges.values()].filter(
          (e) => e.rootId === rootId,
        );
        return {
          records: rows.map(
            (e) =>
              new FakeNeo4jRecord({
                source: e.source,
                target: e.target,
                kind: e.kind,
                label: e.label,
              }),
          ),
        };
      }

      case NEO4J_GRAPH_QUERIES.shortestPath: {
        const rootId = params.rootId as string;
        const fromId = params.fromId as string;
        const toId = params.toId as string;
        const fromExists = this.nodes.has(this.nodeKey(rootId, fromId));
        const toExists = this.nodes.has(this.nodeKey(rootId, toId));
        if (!fromExists || !toExists) return { records: [] };

        const path = this.bfsShortestPath(rootId, fromId, toId, 15);
        if (!path) return { records: [] };
        return {
          records: [
            new FakeNeo4jRecord({
              nodeIds: path,
              pathLength: path.length - 1,
            }),
          ],
        };
      }

      default:
        throw new Error(
          `FakeNeo4jDriver: unrecognized query (no handler wired for this exact ` +
            `cypher string): ${cypher}`,
        );
    }
  }

  /** BFS over an undirected view of `LINKS_TO` edges (the real query's
   * `-[:LINKS_TO*..15]-` pattern carries no arrowhead, so it matches either
   * direction) — mirrors the Cypher `shortestPath` semantics this fake stands in
   * for, bounded to the same 15-hop cap. */
  private bfsShortestPath(
    rootId: string,
    fromId: string,
    toId: string,
    maxHops: number,
  ): string[] | null {
    if (fromId === toId) return [fromId];

    const adjacency = new Map<string, Set<string>>();
    const addEdge = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    };
    for (const edge of this.edges.values()) {
      if (edge.rootId !== rootId) continue;
      addEdge(edge.source, edge.target);
      addEdge(edge.target, edge.source);
    }

    const visited = new Set<string>([fromId]);
    let frontier: string[][] = [[fromId]];
    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier: string[][] = [];
      for (const path of frontier) {
        const last = path[path.length - 1];
        for (const neighbor of adjacency.get(last) ?? []) {
          if (neighbor === toId) return [...path, neighbor];
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          nextFrontier.push([...path, neighbor]);
        }
      }
      if (nextFrontier.length === 0) return null;
      frontier = nextFrontier;
    }
    return null;
  }
}
