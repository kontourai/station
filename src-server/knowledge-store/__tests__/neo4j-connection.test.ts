import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import {
  clearNeo4jGraphViewConnection,
  getNeo4jGraphViewConnection,
  NEO4J_GRAPH_VIEW_CONNECTION_TYPE,
  queryNeo4jGraphView,
  registerNeo4jGraphViewConnection,
  validateNeo4jGraphViewConnection,
} from '../neo4j-connection.js';
import {
  createNeo4jDriver,
  readGraph,
  shortestPath,
} from '../neo4j-graph-provider.js';
import { syncRootToNeo4j } from '../neo4j-graph-sync.js';

afterEach(() => {
  clearNeo4jGraphViewConnection();
});

describe('Neo4j graph-view connection type + registration plumbing', () => {
  test('connection type constant is stable', () => {
    expect(NEO4J_GRAPH_VIEW_CONNECTION_TYPE).toBe('neo4j-graph-view');
  });

  test('no connection registered by default', () => {
    expect(getNeo4jGraphViewConnection()).toBeNull();
  });

  test('register then get round-trips the config', () => {
    registerNeo4jGraphViewConnection({ uri: 'neo4j://localhost:7687' });
    expect(getNeo4jGraphViewConnection()).toEqual({
      uri: 'neo4j://localhost:7687',
    });
  });

  test('registering again replaces (last-write-wins), matching connection-factories.ts precedent', () => {
    registerNeo4jGraphViewConnection({ uri: 'neo4j://first:7687' });
    registerNeo4jGraphViewConnection({
      uri: 'neo4j://second:7687',
      database: 'personal',
    });
    expect(getNeo4jGraphViewConnection()).toEqual({
      uri: 'neo4j://second:7687',
      database: 'personal',
    });
  });

  test('clearNeo4jGraphViewConnection deregisters', () => {
    registerNeo4jGraphViewConnection({ uri: 'neo4j://localhost:7687' });
    clearNeo4jGraphViewConnection();
    expect(getNeo4jGraphViewConnection()).toBeNull();
  });
});

describe('validateNeo4jGraphViewConnection — honest reachability (no live Neo4j daemon dependency)', () => {
  test('null config -> not configured', async () => {
    const result = await validateNeo4jGraphViewConnection(null);
    expect(result).toEqual({ ok: false, reason: 'not configured' });
  });

  test('empty uri -> not configured', async () => {
    const result = await validateNeo4jGraphViewConnection({ uri: '' });
    expect(result).toEqual({ ok: false, reason: 'not configured' });
  });

  test('malformed uri -> ok:false naming the parse failure, never throws', async () => {
    const result = await validateNeo4jGraphViewConnection({
      uri: 'not a valid uri',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('invalid Neo4j URI');
  });

  test('a URI whose host refuses the TCP connection -> ok:false, honest "not reachable" reason (fast — connection-refused, not a timeout)', async () => {
    // Port 1 is a reserved/unassigned low port on loopback that nothing binds to in
    // any normal environment/CI sandbox, so this resolves via a fast
    // connection-refused, not the (slower) timeout branch, and requires no live
    // Neo4j daemon.
    const result = await validateNeo4jGraphViewConnection(
      { uri: 'neo4j://127.0.0.1:1' },
      { timeoutMs: 500 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not reachable');
    expect(result.reason).toContain('127.0.0.1:1');
  });

  test('a URI omitting a port defaults to the bolt default (7687) in the reachability message', async () => {
    const result = await validateNeo4jGraphViewConnection(
      { uri: 'neo4j://127.0.0.1' },
      { timeoutMs: 500 },
    );
    // 127.0.0.1:7687 is very unlikely to have anything listening in a test
    // sandbox; if it somehow does, this assertion is skipped in favor of the
    // reachable-but-unverifiable branch below (both are "no throw, honest reason"
    // outcomes so either is an acceptable, non-flaky pass).
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/127\.0\.0\.1:7687/);
  });

  test('a TCP-reachable host (something IS listening) is still ok:false — K2 never overclaims a live bolt handshake it never performed', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected server.address() to be an AddressInfo');
    }
    try {
      const result = await validateNeo4jGraphViewConnection(
        { uri: `neo4j://127.0.0.1:${address.port}` },
        { timeoutMs: 1500 },
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('TCP-reachable');
      expect(result.reason).toContain('not verifiable');
    } finally {
      server.close();
    }
  });
});

describe('queryNeo4jGraphView — honest no-op stub (K2 ships no graph-sync client)', () => {
  test('not configured -> ok:false, reason names it', async () => {
    const result = await queryNeo4jGraphView(null, 'MATCH (n) RETURN n');
    expect(result).toEqual({ ok: false, reason: 'not configured' });
  });

  test('configured -> still ok:false, reason names "not implemented" rather than silently returning empty success', async () => {
    const result = await queryNeo4jGraphView(
      { uri: 'neo4j://localhost:7687' },
      'MATCH (n) RETURN n',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not implemented');
  });
});

// ── Live integration (env-guarded, skipped — not silently passed — when unset) ───
//
// Recorded manual protocol (mirrors the Kit's own README's "Docker-based live
// integration, run locally" pattern, per this plan's ground note 6):
//
//   1. Start a real Neo4j instance locally, e.g.:
//        docker run --rm -p 7687:7687 -p 7474:7474 \
//          -e NEO4J_AUTH=neo4j/localtestpass neo4j:5
//   2. Export the bolt URI for this test to pick up:
//        export KNOWLEDGE_NEO4J_TEST_URL=neo4j://localhost:7687
//   3. Run: npx vitest run src-server/knowledge-store/__tests__/neo4j-connection.test.ts
//
// When KNOWLEDGE_NEO4J_TEST_URL is unset (the default — CI and every other gate run
// in this repo), this suite is explicitly SKIPPED (visible in the vitest summary as
// a skipped test, not silently absent) rather than faked as green.
const liveUri = process.env.KNOWLEDGE_NEO4J_TEST_URL;
describe.skipIf(!liveUri)(
  'live Neo4j reachability (env-guarded via KNOWLEDGE_NEO4J_TEST_URL)',
  () => {
    test('validateNeo4jGraphViewConnection against a real daemon is TCP-reachable but still honestly unverified (no driver)', async () => {
      const result = await validateNeo4jGraphViewConnection({ uri: liveUri! });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('TCP-reachable');
    });
  },
);

// ── s203-knowledge-meeting-notes Wave 1 Task 1: live sync + readGraph +
// shortestPath against the same real, local Docker Neo4j daemon named above.
// Same skip-not-pass discipline: SKIPPED (not silently passed) whenever
// KNOWLEDGE_NEO4J_TEST_URL is unset. Cleans up every node/edge it creates
// (scoped to its own generated `rootId`) so repeat local runs against the same
// long-lived Docker container don't accumulate stray graph state.
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

describe.skipIf(!liveUri)(
  'live Neo4j sync + readGraph + shortestPath (env-guarded via KNOWLEDGE_NEO4J_TEST_URL)',
  () => {
    test("sync projects a root's records+links; readGraph/shortestPath read them back from the real daemon", async () => {
      const driverResult = await createNeo4jDriver({ uri: liveUri! });
      expect(driverResult.ok).toBe(true);
      const driver = driverResult.driver!;

      const storeDir = mkdtempSync(
        join(tmpdir(), 'neo4j-connection-live-store-'),
      );
      const persistence = new FakeRootPersistence();
      const store = new KnowledgeStoreProvider(persistence);
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: storeDir,
        displayName: 'Live Neo4j smoke-test root',
      });
      const rootId = root.id;

      try {
        const adapter = await store.adapterFor(rootId);
        const rawId = await adapter.create({
          type: 'raw',
          title: 'Live smoke-test transcript',
          body: 'raw transcript body',
          category: 'meeting-notes',
          provenance: { agent: 'test' },
        });
        const compiledId = await adapter.create({
          type: 'compiled',
          title: 'Live smoke-test note',
          body: 'compiled summary',
          category: 'meeting-notes',
          links: [{ target_id: rawId, kind: 'source' }],
          provenance: { agent: 'test', source_ids: [rawId] },
        });

        const firstSync = await syncRootToNeo4j({ rootId, store, driver });
        expect(firstSync.nodesWritten).toBe(2);
        expect(firstSync.linksWritten).toBe(1);

        const secondSync = await syncRootToNeo4j({ rootId, store, driver });
        expect(secondSync.nodesWritten).toBe(0);
        expect(secondSync.nodesUnchanged).toBe(2);
        expect(secondSync.linksWritten).toBe(0);
        expect(secondSync.linksUnchanged).toBe(1);

        const graph = await readGraph(driver, rootId);
        expect(graph.nodes.map((n) => n.id)).toEqual(
          expect.arrayContaining([rawId, compiledId]),
        );
        expect(graph.edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: compiledId,
              target: rawId,
              kind: 'source',
            }),
          ]),
        );

        const path = await shortestPath(driver, rootId, compiledId, rawId);
        expect(path).toEqual({ nodeIds: [compiledId, rawId], length: 1 });
      } finally {
        const session = driver.session();
        try {
          await session.run(
            'MATCH (n:KitRecord {rootId: $rootId}) DETACH DELETE n',
            { rootId },
          );
        } finally {
          await session.close();
        }
        await driver.close();
        rmSync(storeDir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
