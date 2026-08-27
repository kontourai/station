import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../__test-utils__/read-json.js';
import { FakeNeo4jDriver } from '../../knowledge-store/__tests__/fake-neo4j-driver.js';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import type { Neo4jGraphViewConnectionConfig } from '../../knowledge-store/neo4j-connection.js';
import type { Neo4jDriverLoadResult } from '../../knowledge-store/neo4j-graph-provider.js';
import { syncRootToNeo4j } from '../../knowledge-store/neo4j-graph-sync.js';
import { createNeo4jGraphRoutes } from '../knowledge/neo4j-graph-routes.js';

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

describe('neo4j-graph routes', () => {
  let storeDir: string;
  let store: KnowledgeStoreProvider;
  let rootId: string;
  let driver: FakeNeo4jDriver;
  const connection: Neo4jGraphViewConnectionConfig = {
    uri: 'neo4j://localhost:7687',
  };

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'neo4j-graph-routes-store-'));
    const persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
    const root = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: storeDir,
      displayName: 'Personal knowledge',
    });
    rootId = root.id;
    driver = new FakeNeo4jDriver();
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function configuredApp() {
    return createNeo4jGraphRoutes({
      store,
      getConnection: () => connection,
      resolveDriver: async (): Promise<Neo4jDriverLoadResult> => ({
        ok: true,
        driver,
      }),
    });
  }

  function unconfiguredApp() {
    return createNeo4jGraphRoutes({
      store,
      getConnection: () => null,
    });
  }

  function unreachableApp() {
    return createNeo4jGraphRoutes({
      store,
      getConnection: () => connection,
      resolveDriver: async (): Promise<Neo4jDriverLoadResult> => ({
        ok: false,
        reason: 'not reachable: simulated',
      }),
    });
  }

  describe('configuration gating', () => {
    test('no connection configured -> 503 on sync', async () => {
      const app = unconfiguredApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j-sync`, {
        method: 'POST',
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
    });

    test('no connection configured -> 503 on readGraph', async () => {
      const app = unconfiguredApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j`);
      expect(res.status).toBe(503);
    });

    test('no connection configured -> 503 on shortest-path', async () => {
      const app = unconfiguredApp();
      const res = await app.request(
        `/roots/${rootId}/graph/neo4j/shortest-path?fromId=a&toId=b`,
      );
      expect(res.status).toBe(503);
    });

    test('driver unavailable (e.g. unreachable daemon) -> 503, honest reason, never a crash', async () => {
      const app = unreachableApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j`);
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(503);
      expect(body.error).toContain('not reachable');
    });

    test('an invalid rootId shape -> 400, checked before any connection/driver work', async () => {
      const app = unconfiguredApp();
      const res = await app.request(
        `/roots/${encodeURIComponent('bad\u0000id')}/graph/neo4j`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /roots/:rootId/graph/neo4j-sync', () => {
    test('syncs the root and returns sync stats', async () => {
      const adapter = await store.adapterFor(rootId);
      await adapter.create({
        type: 'raw',
        title: 'Meeting transcript',
        body: 'raw transcript body',
        category: 'meeting-notes',
        provenance: { agent: 'test' },
      });

      const app = configuredApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j-sync`, {
        method: 'POST',
      });
      const body = await readJson<{
        success: boolean;
        data: { recordsScanned: number; nodesWritten: number };
      }>(res);
      expect(res.status).toBe(200);
      expect(body.data.recordsScanned).toBe(1);
      expect(body.data.nodesWritten).toBe(1);
    });
  });

  describe('GET /roots/:rootId/graph/neo4j', () => {
    test('reads back a previously synced graph', async () => {
      const adapter = await store.adapterFor(rootId);
      const rawId = await adapter.create({
        type: 'raw',
        title: 'Meeting transcript',
        body: 'raw transcript body',
        category: 'meeting-notes',
        provenance: { agent: 'test' },
      });
      const compiledId = await adapter.create({
        type: 'compiled',
        title: 'Meeting notes',
        body: 'compiled summary',
        category: 'meeting-notes',
        links: [{ target_id: rawId, kind: 'source' }],
        provenance: { agent: 'test', source_ids: [rawId] },
      });
      await syncRootToNeo4j({ rootId, store, driver });

      const app = configuredApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j`);
      const body = await readJson<{
        success: boolean;
        data: {
          nodes: Array<{ id: string }>;
          edges: Array<{ source: string; target: string; kind: string }>;
        };
      }>(res);
      expect(res.status).toBe(200);
      expect(body.data.nodes.map((n) => n.id)).toEqual(
        expect.arrayContaining([rawId, compiledId]),
      );
      expect(body.data.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: compiledId,
            target: rawId,
            kind: 'source',
          }),
        ]),
      );
    });

    test('an unsynced root returns an empty graph, not an error', async () => {
      const app = configuredApp();
      const res = await app.request(`/roots/${rootId}/graph/neo4j`);
      const body = await readJson<{
        success: boolean;
        data: { nodes: unknown[]; edges: unknown[] };
      }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('GET /roots/:rootId/graph/neo4j/shortest-path', () => {
    test('returns the provenance-chain path between two synced records', async () => {
      const adapter = await store.adapterFor(rootId);
      const rawId = await adapter.create({
        type: 'raw',
        title: 'Meeting transcript',
        body: 'raw transcript body',
        category: 'meeting-notes',
        provenance: { agent: 'test' },
      });
      const compiledId = await adapter.create({
        type: 'compiled',
        title: 'Meeting notes',
        body: 'compiled summary',
        category: 'meeting-notes',
        links: [{ target_id: rawId, kind: 'source' }],
        provenance: { agent: 'test', source_ids: [rawId] },
      });
      await syncRootToNeo4j({ rootId, store, driver });

      const app = configuredApp();
      const res = await app.request(
        `/roots/${rootId}/graph/neo4j/shortest-path?fromId=${compiledId}&toId=${rawId}`,
      );
      const body = await readJson<{
        success: boolean;
        data: { nodeIds: string[]; length: number } | null;
      }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ nodeIds: [compiledId, rawId], length: 1 });
    });

    test('no path -> 200 with data: null, never a 500', async () => {
      const app = configuredApp();
      const res = await app.request(
        `/roots/${rootId}/graph/neo4j/shortest-path?fromId=does-not-exist-a&toId=does-not-exist-b`,
      );
      const body = await readJson<{ success: boolean; data: unknown }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toBeNull();
    });

    test('a traversal-shaped fromId is rejected with 400 (SEC-1)', async () => {
      const app = configuredApp();
      const res = await app.request(
        `/roots/${rootId}/graph/neo4j/shortest-path?${new URLSearchParams({
          fromId: '../../../etc/passwd',
          toId: 'safe-id',
        }).toString()}`,
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/fromId/i);
    });

    test('a traversal-shaped toId is rejected with 400 (SEC-1)', async () => {
      const app = configuredApp();
      const res = await app.request(
        `/roots/${rootId}/graph/neo4j/shortest-path?${new URLSearchParams({
          fromId: 'safe-id',
          toId: '../../../etc/passwd',
        }).toString()}`,
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/toId/i);
    });
  });
});
