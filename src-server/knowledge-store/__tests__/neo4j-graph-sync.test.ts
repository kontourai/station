import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KitRecord,
  KitRecordType,
  KnowledgeStoreAdapter,
  KnowledgeStoreProvider as KnowledgeStoreProviderContract,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import { syncRootToNeo4j } from '../neo4j-graph-sync.js';
import { FakeNeo4jDriver } from './fake-neo4j-driver.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * same fixture shape used by knowledge-record.routes.test.ts. */
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

/**
 * A minimal, order-controlled `KnowledgeStoreProvider`+adapter double used ONLY
 * by the same-type forward-reference regression test below. The real
 * `kit-default-store` adapter's `listByType` order comes from `readdirSync`
 * enumeration (`default-store.ts`'s `listIds`) — filesystem/OS directory-listing
 * order, NOT creation order and not a documented sort guarantee — so it cannot
 * be relied on to deterministically reproduce "target not yet visited within
 * the same type" the way `ALL_KIT_RECORD_TYPES`'s fixed cross-type order can.
 * This double gives the test direct, deterministic control over the exact
 * array `syncRootToNeo4j` walks, isolating the assertion to the sync module's
 * own two-pass behavior rather than incidental filesystem ordering.
 */
function orderedFakeStore(
  recordsByType: Partial<Record<KitRecordType, KitRecord[]>>,
): KnowledgeStoreProviderContract {
  const notImplemented = (method: string) => () => {
    throw new Error(
      `orderedFakeStore: '${method}' not implemented (unused by syncRootToNeo4j)`,
    );
  };
  const adapter: KnowledgeStoreAdapter = {
    create: notImplemented('create'),
    update: notImplemented('update'),
    link: notImplemented('link'),
    propose: notImplemented('propose'),
    apply: notImplemented('apply'),
    reject: notImplemented('reject'),
    supersede: notImplemented('supersede'),
    retire: notImplemented('retire'),
    get: notImplemented('get'),
    getLinks: notImplemented('getLinks'),
    listByCategory: notImplemented('listByCategory'),
    listByType: async (type) => recordsByType[type] ?? [],
  };
  return {
    listRoots: notImplemented('listRoots'),
    getRoot: notImplemented('getRoot'),
    createRoot: notImplemented('createRoot'),
    removeRoot: notImplemented('removeRoot'),
    registerAdapter: notImplemented('registerAdapter'),
    listAdapters: notImplemented('listAdapters'),
    validateRootForAdapter: notImplemented('validateRootForAdapter'),
    adapterFor: async () => adapter,
    onRecordsChanged: () => () => {},
  };
}

function makeRecord(
  overrides: Partial<KitRecord> & Pick<KitRecord, 'id' | 'type'>,
): KitRecord {
  return {
    title: `Record ${overrides.id}`,
    body: 'body',
    category: 'meeting-notes',
    provenance: { agent: 'test' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('syncRootToNeo4j', () => {
  let storeDir: string;
  let store: KnowledgeStoreProvider;
  let rootId: string;
  let driver: FakeNeo4jDriver;

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'neo4j-graph-sync-store-'));
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

  test('an empty root syncs cleanly with zero writes, not an error', async () => {
    const stats = await syncRootToNeo4j({ rootId, store, driver });
    expect(stats).toEqual({
      rootId,
      recordsScanned: 0,
      linksScanned: 0,
      nodesWritten: 0,
      nodesUnchanged: 0,
      linksWritten: 0,
      linksUnchanged: 0,
      linksSkippedDangling: 0,
    });
    expect(driver.writeCallCount).toBe(0);
  });

  test('first sync writes every node and edge; a content-hash-unchanged second sync writes zero', async () => {
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

    const first = await syncRootToNeo4j({ rootId, store, driver });
    expect(first.recordsScanned).toBe(2);
    expect(first.nodesWritten).toBe(2);
    expect(first.nodesUnchanged).toBe(0);
    expect(first.linksWritten).toBe(1);
    expect(first.linksUnchanged).toBe(0);
    const writesAfterFirst = driver.writeCallCount;
    expect(writesAfterFirst).toBeGreaterThan(0);

    const second = await syncRootToNeo4j({ rootId, store, driver });
    expect(second.recordsScanned).toBe(2);
    expect(second.nodesWritten).toBe(0);
    expect(second.nodesUnchanged).toBe(2);
    expect(second.linksWritten).toBe(0);
    expect(second.linksUnchanged).toBe(1);
    // The idempotency contract's own observable: no additional write-query calls
    // were issued on the second, unchanged-data pass.
    expect(driver.writeCallCount).toBe(writesAfterFirst);

    void compiledId;
  });

  test('a changed title after a first sync triggers exactly one node re-write on the next sync', async () => {
    const adapter = await store.adapterFor(rootId);
    const rawId = await adapter.create({
      type: 'raw',
      title: 'Original title',
      body: 'body',
      category: 'meeting-notes',
      provenance: { agent: 'test' },
    });

    await syncRootToNeo4j({ rootId, store, driver });
    const writesAfterFirst = driver.writeCallCount;

    await adapter.update(rawId, { title: 'Updated title' }, { agent: 'test' });

    const second = await syncRootToNeo4j({ rootId, store, driver });
    expect(second.nodesWritten).toBe(1);
    expect(second.nodesUnchanged).toBe(0);
    expect(driver.writeCallCount).toBe(writesAfterFirst + 1);
  });

  test("a link to a target_id that is not among the root's own records is skipped, not written as a dangling edge", async () => {
    const adapter = await store.adapterFor(rootId);
    // `kit-default-store`'s own `create()` does not validate that
    // `input.links[].target_id` resolves to an existing record (only `link()`
    // does — verified by reading `default-store.ts`), so a dangling link is
    // reachable directly through the adapter's own contract, not just a
    // hand-fabricated fixture.
    await adapter.create({
      type: 'raw',
      title: 'Has a dangling link',
      body: 'body',
      category: 'meeting-notes',
      links: [{ target_id: 'does-not-exist-anywhere', kind: 'source' }],
      provenance: { agent: 'test' },
    });

    const stats = await syncRootToNeo4j({ rootId, store, driver });
    expect(stats.recordsScanned).toBe(1);
    expect(stats.linksScanned).toBe(1);
    expect(stats.linksSkippedDangling).toBe(1);
    expect(stats.linksWritten).toBe(0);
    expect(stats.linksUnchanged).toBe(0);

    const graph = await import('../neo4j-graph-provider.js').then((m) =>
      m.readGraph(driver, rootId),
    );
    expect(graph.edges).toEqual([]);
  });

  test(
    'a forward-reference link (source type sorts BEFORE target type in ' +
      'ALL_KIT_RECORD_TYPES, so the target has not been visited yet in a ' +
      'single interleaved pass) is still written as a real edge — the masked ' +
      "case this file's own doc comment names (a `raw` record linking to a " +
      "`compiled` record; this PR's own happy-path test above only exercises " +
      'the opposite, always-safe `compiled -> raw` direction)',
    async () => {
      const adapter = await store.adapterFor(rootId);
      // Create the target (`compiled`) FIRST so this is not just a creation-
      // order coincidence — `listByType` groups by type in `ALL_KIT_RECORD_TYPES`
      // order regardless of creation order, so `raw` records are always visited
      // before `compiled` records in the flat `records` array a single pass
      // would walk.
      const compiledId = await adapter.create({
        type: 'compiled',
        title: 'Meeting notes',
        body: 'compiled summary',
        category: 'meeting-notes',
        provenance: { agent: 'test' },
      });
      const rawId = await adapter.create({
        type: 'raw',
        title: 'Meeting transcript',
        body: 'raw transcript body',
        category: 'meeting-notes',
        links: [{ target_id: compiledId, kind: 'derived-from' }],
        provenance: { agent: 'test' },
      });

      const stats = await syncRootToNeo4j({ rootId, store, driver });
      expect(stats.recordsScanned).toBe(2);
      expect(stats.linksScanned).toBe(1);
      expect(stats.linksSkippedDangling).toBe(0);
      // The masked bug's exact symptom: a single-pass sync would still report
      // `linksWritten: 1` here (the `MATCH` silently no-ops but the code never
      // checks for that), so this assertion alone does not distinguish old vs
      // new behavior — the `readGraph` assertion below is the real proof.
      expect(stats.linksWritten).toBe(1);

      const graph = await import('../neo4j-graph-provider.js').then((m) =>
        m.readGraph(driver, rootId),
      );
      expect(graph.edges).toEqual([
        {
          source: rawId,
          target: compiledId,
          kind: 'derived-from',
          label: undefined,
        },
      ]);

      // Idempotency must still hold for this direction too: a second sync
      // against unchanged data reports the edge unchanged, not written again.
      const second = await syncRootToNeo4j({ rootId, store, driver });
      expect(second.linksWritten).toBe(0);
      expect(second.linksUnchanged).toBe(1);
    },
  );

  test(
    'a same-type forward-reference link (source appears BEFORE its target in ' +
      'the `listByType` array for that type — an ordering `syncRootToNeo4j` ' +
      "doesn't control and can't assume away) is still written as a real edge",
    async () => {
      const sourceId = 'raw-source';
      const targetId = 'raw-target';
      // Deterministic, order-controlled double (see `orderedFakeStore` above) —
      // the source record is placed BEFORE its own link target in the exact
      // array `syncRootToNeo4j` walks, reproducing the masked ordering
      // regardless of any real adapter's incidental enumeration order.
      const orderedStore = orderedFakeStore({
        raw: [
          makeRecord({
            id: sourceId,
            type: 'raw',
            links: [{ target_id: targetId, kind: 'related' }],
          }),
          makeRecord({ id: targetId, type: 'raw' }),
        ],
      });

      const stats = await syncRootToNeo4j({
        rootId,
        store: orderedStore,
        driver,
      });
      expect(stats.recordsScanned).toBe(2);
      expect(stats.linksScanned).toBe(1);
      expect(stats.linksSkippedDangling).toBe(0);
      // Same masked-bug shape as the cross-type case above: a single-pass sync
      // would still self-report `linksWritten: 1` here even though the fake
      // driver's honest `MATCH` simulation (see `fake-neo4j-driver.ts`) would
      // have silently created nothing — the `readGraph` assertion below is
      // the real, non-self-reported proof.
      expect(stats.linksWritten).toBe(1);

      const graph = await import('../neo4j-graph-provider.js').then((m) =>
        m.readGraph(driver, rootId),
      );
      expect(graph.edges).toEqual([
        {
          source: sourceId,
          target: targetId,
          kind: 'related',
          label: undefined,
        },
      ]);
    },
  );
});
