import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  initializeRootBinding,
  KitDefaultStoreAdapter,
} from '@kontourai/corpus-store';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { SqliteVecIndexProvider } from '../../knowledge-index/sqlite-vec-index-provider.js';
import { createKnowledgeIndexRoutes } from '../../routes/knowledge/knowledge-index-routes.js';
import { createNeo4jGraphRoutes } from '../../routes/knowledge/neo4j-graph-routes.js';
import { FakeNeo4jDriver } from './fake-neo4j-driver.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import { syncRootToNeo4j } from '../neo4j-graph-sync.js';
import { MemoryErasureCoordinator } from '../memory-erasure-coordinator.js';
import { MemoryRootManager } from '../memory-root.js';

const makeTempDir = trackTempDirs();
const owner = sessionReadAuthorityFromRequest(
  'human:owner',
  undefined,
  undefined,
);
const current = () => {};
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const home = makeTempDir('station-memory-erasure-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  const manager = new MemoryRootManager(store, persistence, home, () => true);
  const root = await manager.ensureRoot(owner, current);
  const proposal = await manager.propose(
    owner,
    root,
    current,
    {
      type: 'raw',
      title: 'Memory',
      body: 'erasable-unique-text-7529',
      category: 'memory',
      provenance: { agent: 'source' },
    },
    { agent: 'source', proposal: 'evidence' },
    'agent:source',
    'source',
  );
  const id = await manager.applyCreate(owner, root, current, proposal);
  const dbPath = join(home, 'index.db');
  const index = new SqliteVecIndexProvider({ dbPath });
  const embedder = {
    id: 'test',
    displayName: 'test',
    dimensions: () => 3,
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  };
  await index.rebuildRoot(root.id, {
    store,
    embedder,
    withRootRevision: manager.rebuildFence(owner, root, current),
  });
  const coordinator = new MemoryErasureCoordinator(home, store, manager, index);
  return {
    home,
    persistence,
    store,
    manager,
    root,
    id,
    dbPath,
    index,
    embedder,
    coordinator,
  };
}

test('purges with the confirmed revision, cleans index bytes and returns Corpus effects', async () => {
  const f = await setup();
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview || preview.kind !== 'record')
      throw new Error('Expected record preview');
    const receipt = await f.coordinator.erase(
      owner,
      f.root,
      current,
      'record',
      f.id,
      preview.impact.revision,
      'purge-1',
    );
    expect(receipt).toMatchObject({
      kind: 'record',
      result: { purged: [f.id], cascaded: [] },
    });
    expect(await (await f.store.adapterFor(f.root.id)).get(f.id)).toBeNull();
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
    const journal = new DatabaseSync(
      join(f.home, 'data', 'memory-erasure', 'intents.sqlite'),
      { readOnly: true },
    );
    try {
      const count = () =>
        Number(
          journal
            .prepare('SELECT count(*) AS n FROM monument_inbox_entries')
            .get()?.n,
        );
      const before = count();
      await f.coordinator.reconcileRoot(f.root);
      await f.coordinator.reconcileRoot(f.root);
      expect(count()).toBe(before);
    } finally {
      journal.close();
    }
    for (const path of [f.dbPath, `${f.dbPath}-wal`])
      if (existsSync(path))
        expect(readFileSync(path).includes('erasable-unique-text-7529')).toBe(
          false,
        );
    expect(
      await f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'purge-1',
      ),
    ).toEqual(receipt);
  } finally {
    f.index.close();
  }
});

test('recovers a committed purge after index cleanup is interrupted', async () => {
  const f = await setup();
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview || preview.kind !== 'record')
      throw new Error('Expected record preview');
    const fault = vi
      .spyOn(f.index, 'removeErasedRecords')
      .mockRejectedValueOnce(new Error('interrupted cleanup'));
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'purge-crash',
      ),
    ).rejects.toThrow('interrupted cleanup');
    fault.mockRestore();
    expect(await (await f.store.adapterFor(f.root.id)).get(f.id)).toBeNull();
    expect((await f.index.stats(f.root.id)).chunks).toBe(1);
    f.index.close();
    const reopenedStore = new KnowledgeStoreProvider(f.persistence);
    const reopenedManager = new MemoryRootManager(
      reopenedStore,
      f.persistence,
      f.home,
      () => false,
    );
    const reopenedIndex = new SqliteVecIndexProvider({ dbPath: f.dbPath });
    try {
      const recovery = new MemoryErasureCoordinator(
        f.home,
        reopenedStore,
        reopenedManager,
        reopenedIndex,
      );
      await recovery.recoverAll();
      expect(
        await reopenedManager.recoveryTargetErased(f.root, 'record', f.id),
      ).toBe(true);
      expect((await reopenedIndex.stats(f.root.id)).chunks).toBe(0);
      for (const path of [f.dbPath, `${f.dbPath}-wal`])
        if (existsSync(path))
          expect(readFileSync(path).includes('erasable-unique-text-7529')).toBe(
            false,
          );
    } finally {
      reopenedIndex.close();
    }
  } finally {
    f.index.close();
  }
});

test('the same request can finish interrupted cleanup without repeating the purge', async () => {
  const f = await setup();
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    const fault = vi
      .spyOn(f.index, 'removeErasedRecords')
      .mockRejectedValueOnce(new Error('interrupted cleanup'));
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'retry',
      ),
    ).rejects.toThrow('interrupted cleanup');
    fault.mockRestore();
    expect(
      await f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'retry',
      ),
    ).toBeNull();
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
  } finally {
    f.index.close();
  }
});

test('an interrupted cleanup does not strand later erasures', async () => {
  const f = await setup();
  try {
    const first = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!first) throw new Error('Expected preview');
    const fault = vi
      .spyOn(f.index, 'removeErasedRecords')
      .mockRejectedValueOnce(new Error('interrupted cleanup'));
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        first.impact.revision,
        'first',
      ),
    ).rejects.toThrow('interrupted cleanup');
    fault.mockRestore();
    const proposal = await f.manager.propose(
      owner,
      f.root,
      current,
      {
        type: 'raw',
        title: 'Second',
        body: 'Second body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'second-source',
    );
    const secondId = await f.manager.applyCreate(
      owner,
      f.root,
      current,
      proposal,
    );
    const second = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      secondId,
    );
    if (!second) throw new Error('Expected second preview');
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        secondId,
        second.impact.revision,
        'second',
      ),
    ).resolves.toMatchObject({ kind: 'record' });
    await f.coordinator.recoverAll();
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
  } finally {
    f.index.close();
  }
});

test('refuses recovery if the Corpus store is replaced after the intent', async () => {
  const f = await setup();
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    const fault = vi
      .spyOn(f.index, 'removeErasedRecords')
      .mockRejectedValueOnce(new Error('interrupted cleanup'));
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'binding',
      ),
    ).rejects.toThrow('interrupted cleanup');
    fault.mockRestore();
    renameSync(f.root.storeRoot, `${f.root.storeRoot}-previous`);
    mkdirSync(f.root.storeRoot);
    const replacementOptions = {
      storeRoot: f.root.storeRoot,
      coordinationDirectory: join(
        f.home,
        'coordination',
        'knowledge-file-transactions',
      ),
      lock: acquireFileMutationLockAsync,
      coordinationIdentity: () => () => {},
    };
    await initializeRootBinding(replacementOptions);
    const reopenedStore = new KnowledgeStoreProvider(f.persistence);
    const reopenedManager = new MemoryRootManager(
      reopenedStore,
      f.persistence,
      f.home,
      () => true,
    );
    await expect(
      new MemoryErasureCoordinator(
        f.home,
        reopenedStore,
        reopenedManager,
        f.index,
      ).recoverAll(),
    ).rejects.toThrow('binding changed');
  } finally {
    f.index.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'recovers after process death between index deletion and compaction',
  async () => {
    const f = await setup();
    try {
      const preview = await f.manager.previewErasureTarget(
        owner,
        f.root,
        current,
        'record',
        f.id,
      );
      if (!preview) throw new Error('Expected preview');
      f.index.close();
      const worker = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./fixtures/memory-erasure-crash.ts', import.meta.url),
          ),
          f.home,
          f.id,
          preview.impact.revision,
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
      const signal = await new Promise<string | null>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (_code, exitSignal) => resolve(exitSignal));
      });
      expect(signal).toBe('SIGKILL');
      const reopenedStore = new KnowledgeStoreProvider(f.persistence);
      const reopenedManager = new MemoryRootManager(
        reopenedStore,
        f.persistence,
        f.home,
        () => true,
      );
      const reopenedIndex = new SqliteVecIndexProvider({ dbPath: f.dbPath });
      try {
        await new MemoryErasureCoordinator(
          f.home,
          reopenedStore,
          reopenedManager,
          reopenedIndex,
        ).recoverAll();
        expect(
          await (await reopenedStore.adapterFor(f.root.id)).get(f.id),
        ).toBeNull();
        expect((await reopenedIndex.stats(f.root.id)).chunks).toBe(0);
        for (const path of [f.dbPath, `${f.dbPath}-wal`])
          if (existsSync(path))
            expect(
              readFileSync(path).includes('erasable-unique-text-7529'),
            ).toBe(false);
      } finally {
        reopenedIndex.close();
      }
    } finally {
      f.index.close();
    }
  },
  30_000,
);

test('rejects a stale preview without erasing the target', async () => {
  const f = await setup();
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    await f.manager.propose(
      owner,
      f.root,
      current,
      {
        type: 'raw',
        title: 'New',
        body: 'new body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'new',
    );
    await expect(
      f.coordinator.erase(
        owner,
        f.root,
        current,
        'record',
        f.id,
        preview.impact.revision,
        'stale',
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(
      await (await f.store.adapterFor(f.root.id)).get(f.id),
    ).not.toBeNull();
  } finally {
    f.index.close();
  }
});

test('Corpus rejects an outside write between the final preview and purge', async () => {
  const f = await setup();
  const external = new KitDefaultStoreAdapter({
    storeRoot: f.root.storeRoot,
    coordinationDirectory: join(
      f.home,
      'coordination',
      'knowledge-file-transactions',
    ),
    lock: acquireFileMutationLockAsync,
    coordinationIdentity: () => () => {},
  });
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    const original = KitDefaultStoreAdapter.prototype.previewPurge;
    const mutation = vi
      .spyOn(KitDefaultStoreAdapter.prototype, 'previewPurge')
      .mockImplementationOnce(async function (
        this: KitDefaultStoreAdapter,
        ids,
      ) {
        const plan = await original.call(this, ids);
        await external.proposeCreate(
          {
            type: 'raw',
            title: 'Outside',
            body: 'New',
            category: 'memory',
            provenance: { agent: 'outside' },
          },
          'outside',
          { agent: 'outside', proposal: 'evidence' },
        );
        return plan;
      });
    try {
      await expect(
        f.coordinator.erase(
          owner,
          f.root,
          current,
          'record',
          f.id,
          preview.impact.revision,
          'outside-race',
        ),
      ).rejects.toMatchObject({ code: 'STALE_REVISION' });
      expect(
        await (await f.store.adapterFor(f.root.id)).get(f.id),
      ).not.toBeNull();
    } finally {
      mutation.mockRestore();
    }
  } finally {
    f.index.close();
  }
});

test('an erasure also reconciles a stale index row from an outside purge', async () => {
  const f = await setup();
  const external = new KitDefaultStoreAdapter({
    storeRoot: f.root.storeRoot,
    coordinationDirectory: join(
      f.home,
      'coordination',
      'knowledge-file-transactions',
    ),
    lock: acquireFileMutationLockAsync,
    coordinationIdentity: () => () => {},
    allowPurge: true,
  });
  try {
    const plan = await external.previewPurge([f.id]);
    await external.purge(
      [f.id],
      { agent: 'outside', rationale: 'test' },
      { expectedRevision: plan.revision },
    );
    expect((await f.index.stats(f.root.id)).chunks).toBe(1);
    const proposal = await f.manager.propose(
      owner,
      f.root,
      current,
      {
        type: 'raw',
        title: 'Second',
        body: 'Second body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'second-for-reconcile',
    );
    const id = await f.manager.applyCreate(owner, f.root, current, proposal);
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      id,
    );
    if (!preview) throw new Error('Expected preview');
    await f.coordinator.erase(
      owner,
      f.root,
      current,
      'record',
      id,
      preview.impact.revision,
      'reconcile-after',
    );
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
  } finally {
    f.index.close();
  }
});

test('a purge between snapshot and publication prevents a stale rebuild', async () => {
  const f = await setup();
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    const embedder = {
      ...f.embedder,
      embed: async (texts: string[]) => {
        entered();
        await paused;
        return texts.map(() => [1, 0, 0]);
      },
    };
    const build = f.index.rebuildRoot(f.root.id, {
      store: f.store,
      embedder,
      withRootRevision: f.manager.rebuildFence(owner, f.root, current),
    });
    await started;
    await f.coordinator.erase(
      owner,
      f.root,
      current,
      'record',
      f.id,
      preview.impact.revision,
      'race',
    );
    release();
    await expect(build).rejects.toThrow('Memory changed during index rebuild.');
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
    for (const path of [f.dbPath, `${f.dbPath}-wal`])
      if (existsSync(path))
        expect(readFileSync(path).includes('erasable-unique-text-7529')).toBe(
          false,
        );
  } finally {
    release();
    f.index.close();
  }
});

test('a graph assembled before erasure does not deliver the erased title', async () => {
  const f = await setup();
  try {
    const driver = new FakeNeo4jDriver();
    await syncRootToNeo4j({ rootId: f.root.id, store: f.store, driver });
    const app = createNeo4jGraphRoutes({
      store: f.store,
      getConnection: () => ({ uri: 'neo4j://localhost:7687' }),
      resolveDriver: async () => ({ ok: true, driver }),
      mayUseRoot: async () => true,
    });
    const response = await app.request(`/roots/${f.root.id}/graph/neo4j`);
    expect(response.status).toBe(200);
    const path = await app.request(
      `/roots/${f.root.id}/graph/neo4j/shortest-path?fromId=${f.id}&toId=${f.id}`,
    );
    expect(path.status).toBe(200);
    const preview = await f.manager.previewErasureTarget(
      owner,
      f.root,
      current,
      'record',
      f.id,
    );
    if (!preview) throw new Error('Expected preview');
    await f.coordinator.erase(
      owner,
      f.root,
      current,
      'record',
      f.id,
      preview.impact.revision,
      'graph-race',
    );
    await expect(response.text()).rejects.toThrow();
    await expect(path.text()).rejects.toThrow();
    const after = await app.request(`/roots/${f.root.id}/graph/neo4j`);
    expect(await after.text()).not.toContain('Memory');
  } finally {
    f.index.close();
  }
});

test('an outside purge in the publication window is hidden and later reconciled', async () => {
  const f = await setup();
  const external = new KitDefaultStoreAdapter({
    storeRoot: f.root.storeRoot,
    coordinationDirectory: join(
      f.home,
      'coordination',
      'knowledge-file-transactions',
    ),
    lock: acquireFileMutationLockAsync,
    coordinationIdentity: () => () => {},
    allowPurge: true,
  });
  const original = KitDefaultStoreAdapter.prototype.previewPurge;
  let reads = 0;
  const fault = vi
    .spyOn(KitDefaultStoreAdapter.prototype, 'previewPurge')
    .mockImplementation(async function (this: KitDefaultStoreAdapter, ids) {
      const plan = await original.call(this, ids);
      if (++reads === 3)
        await external.purge(
          [f.id],
          { agent: 'outside', rationale: 'test' },
          { expectedRevision: plan.revision },
        );
      return plan;
    });
  try {
    await f.index.rebuildRoot(f.root.id, {
      store: f.store,
      embedder: f.embedder,
      withRootRevision: f.manager.rebuildFence(owner, f.root, current),
    });
    fault.mockRestore();
    expect((await f.index.stats(f.root.id)).chunks).toBe(1);
    const app = createKnowledgeIndexRoutes({
      store: f.store,
      indexProvider: f.index,
      dataDir: f.home,
      getEmbedder: () => f.embedder,
    });
    const response = await app.request('/index/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'erasable-unique-text-7529' }),
    });
    expect(await response.json()).toMatchObject({ success: true, data: [] });
    await f.coordinator.reconcileRoot(f.root);
    expect((await f.index.stats(f.root.id)).chunks).toBe(0);
    for (const path of [f.dbPath, `${f.dbPath}-wal`])
      if (existsSync(path))
        expect(readFileSync(path).includes('erasable-unique-text-7529')).toBe(
          false,
        );
  } finally {
    fault.mockRestore();
    f.index.close();
  }
});
