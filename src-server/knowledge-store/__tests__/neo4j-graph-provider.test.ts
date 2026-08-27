import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import {
  createNeo4jDriver,
  readGraph,
  shortestPath,
} from '../neo4j-graph-provider.js';
import { syncRootToNeo4j } from '../neo4j-graph-sync.js';
import { FakeNeo4jDriver } from './fake-neo4j-driver.js';

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

describe('readGraph + shortestPath (fake-driver contract suite)', () => {
  let storeDir: string;
  let store: KnowledgeStoreProvider;
  let rootId: string;
  let driver: FakeNeo4jDriver;
  let rawId: string;
  let compiledId: string;

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'neo4j-graph-provider-store-'));
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

    const adapter = await store.adapterFor(rootId);
    rawId = await adapter.create({
      type: 'raw',
      title: 'Meeting transcript',
      body: 'raw transcript body',
      category: 'meeting-notes',
      provenance: { agent: 'test' },
    });
    compiledId = await adapter.create({
      type: 'compiled',
      title: 'Meeting notes',
      body: 'compiled summary',
      category: 'meeting-notes',
      links: [{ target_id: rawId, kind: 'source' }],
      provenance: { agent: 'test', source_ids: [rawId] },
    });
    await syncRootToNeo4j({ rootId, store, driver });
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  describe('readGraph', () => {
    test('returns nodes+edges shaped for the wikilink pane', async () => {
      const graph = await readGraph(driver, rootId);
      expect(graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: rawId,
            type: 'raw',
            title: 'Meeting transcript',
            category: 'meeting-notes',
          }),
          expect.objectContaining({
            id: compiledId,
            type: 'compiled',
            title: 'Meeting notes',
            category: 'meeting-notes',
          }),
        ]),
      );
      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toEqual([
        { source: compiledId, target: rawId, kind: 'source', label: undefined },
      ]);
    });

    test('an unsynced root returns an empty graph, not an error', async () => {
      const emptyDriver = new FakeNeo4jDriver();
      const graph = await readGraph(emptyDriver, 'root:never-synced');
      expect(graph).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('shortestPath', () => {
    test('finds the provenance chain from the compiled note back to its raw source', async () => {
      const path = await shortestPath(driver, rootId, compiledId, rawId);
      expect(path).toEqual({ nodeIds: [compiledId, rawId], length: 1 });
    });

    test('is direction-agnostic (source -> target still resolves the reverse query direction)', async () => {
      const path = await shortestPath(driver, rootId, rawId, compiledId);
      expect(path).toEqual({ nodeIds: [rawId, compiledId], length: 1 });
    });

    test('returns null (never throws) when no path exists', async () => {
      const adapter = await store.adapterFor(rootId);
      const isolatedId = await adapter.create({
        type: 'raw',
        title: 'Unrelated record',
        body: 'no links to anything',
        category: 'meeting-notes',
        provenance: { agent: 'test' },
      });
      await syncRootToNeo4j({ rootId, store, driver });

      const path = await shortestPath(driver, rootId, rawId, isolatedId);
      expect(path).toBeNull();
    });

    test("returns null (never throws) when an endpoint isn't in the synced graph at all", async () => {
      const path = await shortestPath(
        driver,
        rootId,
        rawId,
        'does-not-exist-anywhere',
      );
      expect(path).toBeNull();
    });
  });
});

describe('createNeo4jDriver — lazy, guarded real-driver loading', () => {
  test('missing uri -> ok:false, "not configured", no import attempted', async () => {
    const result = await createNeo4jDriver({ uri: '' });
    expect(result).toEqual({ ok: false, reason: 'not configured' });
  });

  test("a real neo4j-driver package resolves a driver object (package IS present in this repo's node_modules)", async () => {
    const result = await createNeo4jDriver({ uri: 'neo4j://127.0.0.1:65535' });
    // Constructing a driver never connects eagerly (neo4j-driver's own documented
    // lazy-connection behavior) — this only proves the dynamic import + driver
    // construction path succeeds honestly when the package is present.
    expect(result.ok).toBe(true);
    expect(result.driver).toBeDefined();
    await result.driver?.close();
  });

  test('a broken neo4j-driver package (import throws) degrades to ok:false, reason names it, never throws out of this function', async () => {
    vi.resetModules();
    vi.doMock('neo4j-driver', () => {
      throw new Error('simulated broken neo4j-driver install');
    });
    try {
      const { createNeo4jDriver: freshCreateNeo4jDriver } = await import(
        '../neo4j-graph-provider.js'
      );
      const result = await freshCreateNeo4jDriver({
        uri: 'neo4j://localhost:7687',
      });
      expect(result.ok).toBe(false);
      expect(result.driver).toBeUndefined();
      // vitest wraps a throwing `vi.mock`/`vi.doMock` factory's own error message
      // in its own module-mocking diagnostic text, so this asserts the honest
      // "package unavailable" degrade PREFIX this function always attaches
      // (`createNeo4jDriver`'s own doc comment/catch block), not the exact
      // wrapped message text.
      expect(result.reason).toContain('neo4j-driver package unavailable');
    } finally {
      vi.doUnmock('neo4j-driver');
      vi.resetModules();
    }
  });
});
