import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { KitDefaultStoreAdapter } from '@kontourai/corpus-store';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { SqliteVecIndexProvider } from '../../knowledge-index/sqlite-vec-index-provider.js';
import { createKnowledgeIndexRoutes } from '../../routes/knowledge/knowledge-index-routes.js';
import { createKnowledgeStoreRoutes } from '../../routes/knowledge/knowledge-store-routes.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import { MEMORY_ADAPTER_ID, MemoryRootManager } from '../memory-root.js';

const makeTempDir = trackTempDirs();
const owner = sessionReadAuthorityFromRequest(
  'human:owner',
  undefined,
  undefined,
);
const other = sessionReadAuthorityFromRequest(
  'human:other',
  undefined,
  undefined,
);
const current = () => {};

afterEach(() => vi.unstubAllEnvs());

describe('private memory root', () => {
  test('drops a hit purged by another Corpus writer after search assembly', async () => {
    const home = makeTempDir('station-memory-delivery-purge-');
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
        title: 'Private',
        body: 'Private body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'source',
    );
    const id = await manager.applyCreate(owner, root, current, proposal);
    const index = new SqliteVecIndexProvider({
      dbPath: join(home, 'index.db'),
    });
    const embedder = {
      id: 'test',
      displayName: 'test',
      dimensions: () => 3,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    };
    try {
      await index.rebuildRoot(root.id, {
        store,
        embedder,
        withRootRevision: manager.rebuildFence(owner, root, current),
      });
      const app = createKnowledgeIndexRoutes({
        store,
        indexProvider: index,
        dataDir: home,
        getEmbedder: () => embedder,
      });
      const pending = await app.request('/index/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Private body' }),
      });
      expect(pending.status).toBe(200);
      const external = new KitDefaultStoreAdapter({
        storeRoot: root.storeRoot,
        coordinationDirectory: join(
          home,
          'coordination',
          'knowledge-file-transactions',
        ),
        lock: acquireFileMutationLockAsync,
        coordinationIdentity: () => () => {},
        allowPurge: true,
      });
      const preview = await external.previewPurge([id]);
      await external.purge(
        [id],
        { agent: 'owner', rationale: 'test erasure' },
        { expectedRevision: preview.revision },
      );
      expect(await pending.json()).toMatchObject({ success: true, data: [] });
    } finally {
      index.close();
    }
  });
  test('refuses index publication when a Station write changes the captured Corpus revision', async () => {
    const home = makeTempDir('station-memory-rebuild-fence-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    const evidence = { agent: 'source', proposal: 'evidence' };
    const candidate = {
      type: 'raw' as const,
      title: 'Original',
      body: 'Private body',
      category: 'memory',
      provenance: { agent: 'source' },
    };
    const first = await manager.propose(
      owner,
      root,
      current,
      candidate,
      evidence,
      'agent:source',
      'first',
    );
    await manager.applyCreate(owner, root, current, first);
    const second = await manager.propose(
      owner,
      root,
      current,
      { ...candidate, title: 'Second' },
      evidence,
      'agent:source',
      'second',
    );
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const index = new SqliteVecIndexProvider({
      dbPath: join(home, 'index.db'),
    });
    try {
      const build = index.rebuildRoot(root.id, {
        store,
        embedder: {
          id: 'test',
          displayName: 'test',
          dimensions: () => 3,
          embed: async (texts) => {
            entered();
            await paused;
            return texts.map(() => [1, 0, 0]);
          },
        },
        withRootRevision: manager.rebuildFence(owner, root, current),
      });
      await started;
      await manager.applyCreate(owner, root, current, second);
      release();
      await expect(build).rejects.toThrow(
        'Memory changed during index rebuild.',
      );
      expect((await index.stats(root.id)).chunks).toBe(0);
    } finally {
      release();
      index.close();
    }
  });
  test('refuses a preview if a Corpus writer changes the target during lookup', async () => {
    const home = makeTempDir('station-memory-preview-race-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    const proposalId = await manager.propose(
      owner,
      root,
      current,
      {
        type: 'raw',
        title: 'Before',
        body: 'body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'source',
    );
    const recordId = await manager.applyCreate(
      owner,
      root,
      current,
      proposalId,
    );
    const writer = new KitDefaultStoreAdapter({
      storeRoot: root.storeRoot,
      coordinationDirectory: join(
        home,
        'coordination',
        'knowledge-file-transactions',
      ),
      lock: acquireFileMutationLockAsync,
      coordinationIdentity: () => () => {},
    });
    const originalGet = KitDefaultStoreAdapter.prototype.get;
    let reads = 0;
    const spy = vi
      .spyOn(KitDefaultStoreAdapter.prototype, 'get')
      .mockImplementation(async function (
        this: KitDefaultStoreAdapter,
        target,
      ) {
        const result = await originalGet.call(this, target);
        if (++reads === 2)
          await writer.update(
            recordId,
            { title: 'After' },
            { agent: 'writer' },
          );
        return result;
      });
    try {
      await expect(
        manager.previewErasureTarget(owner, root, current, 'record', recordId),
      ).rejects.toThrow('Private memory changed during preview.');
    } finally {
      spy.mockRestore();
    }
  });
  test('previews Corpus effects for an applied proposal and dependent record', async () => {
    const home = makeTempDir('station-memory-impact-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    const evidence = { agent: 'source', proposal: 'evidence' };
    const candidate = {
      type: 'raw' as const,
      title: 'Source',
      body: 'source text',
      category: 'memory',
      provenance: { agent: 'source' },
    };
    const sourceProposal = await manager.propose(
      owner,
      root,
      current,
      candidate,
      evidence,
      'agent:source',
      'source',
    );
    const sourceId = await manager.applyCreate(
      owner,
      root,
      current,
      sourceProposal,
    );
    const dependentProposal = await manager.propose(
      owner,
      root,
      current,
      {
        ...candidate,
        title: 'Dependent',
        provenance: { agent: 'source', source_ids: [sourceId] },
      },
      evidence,
      'agent:source',
      'dependent',
    );
    const dependentId = await manager.applyCreate(
      owner,
      root,
      current,
      dependentProposal,
    );
    const preview = await manager.previewErasureTarget(
      owner,
      root,
      current,
      'proposal',
      sourceProposal,
    );
    expect(preview).toMatchObject({
      kind: 'proposal',
      id: sourceProposal,
      impact: {
        state: 'applied',
        recordId: sourceId,
        revision: expect.any(String),
        record: { purged: [sourceId], cascaded: [dependentId] },
      },
    });
    expect(
      await (await store.adapterFor(root.id)).get(dependentId),
    ).not.toBeNull();
  });
  test('refuses a root whose Corpus binding has disappeared', async () => {
    const home = makeTempDir('station-memory-binding-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    const adapter = await store.adapterFor(root.id);
    unlinkSync(join(root.storeRoot, '.corpus-root-id'));
    await expect(adapter.listByType('raw')).rejects.toThrow();
    await expect(manager.ensureRoot(owner, current)).rejects.toThrow();
  });
  test('registers an owner-private Corpus root and keeps proposals out of records', async () => {
    const home = makeTempDir('station-private-memory-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    expect(root).toMatchObject({
      scope: { kind: 'personal' },
      readPolicy: { kind: 'author-private', ownerId: owner.userId },
      adapterId: MEMORY_ADAPTER_ID,
    });
    expect(await manager.ensureRoot(owner, current)).toEqual(root);
    const candidate = {
      type: 'raw' as const,
      title: 'A proposed memory',
      body: 'private proposed text',
      category: 'memory',
      provenance: { agent: 'dream' },
    };
    const evidence = { agent: 'dream', proposal: 'source evidence' };
    const id = await manager.propose(
      owner,
      root,
      current,
      candidate,
      evidence,
      'agent:dream',
      'request-1',
    );
    expect(
      await manager.propose(
        owner,
        root,
        current,
        candidate,
        evidence,
        'agent:dream',
        'request-1',
      ),
    ).toBe(id);
    const adapter = await store.adapterFor(root.id);
    expect(await adapter.get(id)).toBeNull();
    expect(await adapter.listByType('raw', { includeRetired: true })).toEqual(
      [],
    );
    expect(await manager.listProposals(owner, root, current)).toEqual([
      expect.objectContaining({
        id,
        state: 'pending',
        candidate: expect.objectContaining({ body: candidate.body }),
      }),
    ]);
    await expect(manager.listProposals(other, root, current)).rejects.toThrow();
    await expect(adapter.create(candidate)).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    expect('purge' in adapter).toBe(false);
    const recordId = await manager.applyCreate(owner, root, current, id);
    expect(await adapter.get(recordId)).toMatchObject({ body: candidate.body });
    expect(
      await manager.previewErasureTarget(
        owner,
        root,
        current,
        'record',
        recordId,
      ),
    ).toEqual({
      kind: 'record',
      id: recordId,
      title: candidate.title,
      impact: expect.objectContaining({
        purged: [recordId],
        cascaded: [],
        revision: expect.any(String),
      }),
    });
    expect(
      await manager.previewErasureTarget(
        owner,
        root,
        current,
        'record',
        'missing',
      ),
    ).toBeNull();
    const rejectedId = await manager.propose(
      owner,
      root,
      current,
      { ...candidate, title: 'Rejected' },
      evidence,
      'agent:dream',
      'request-2',
    );
    await manager.rejectCreate(
      owner,
      root,
      current,
      rejectedId,
      'Not supported by evidence',
    );
    expect(await manager.listProposals(owner, root, current)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: rejectedId, state: 'rejected' }),
      ]),
    );
    const selfId = await manager.propose(
      owner,
      root,
      current,
      { ...candidate, title: 'Self proposed' },
      evidence,
      owner.userId,
      'request-3',
    );
    await expect(
      manager.applyCreate(owner, root, current, selfId),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    expect(await adapter.listByType('raw')).toHaveLength(1);
  });

  test('captures a proposal before waiting for the root revision lock', async () => {
    const home = makeTempDir('station-private-memory-capture-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    const manager = new MemoryRootManager(store, persistence, home, () => true);
    const root = await manager.ensureRoot(owner, current);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = persistence.withKnowledgeStoreRoot(root, async () => {
      entered();
      await blocked;
    });
    await started;
    const candidate = {
      type: 'raw' as const,
      title: 'Original',
      body: 'original content',
      category: 'memory',
      provenance: { agent: 'dream' },
    };
    const evidence = { agent: 'dream', proposal: 'original evidence' };
    const pending = manager.propose(
      owner,
      root,
      current,
      candidate,
      evidence,
      'agent:dream',
      'capture-request',
    );
    candidate.body = 'changed content';
    evidence.proposal = 'changed evidence';
    release();
    await held;
    const id = await pending;
    expect(await manager.listProposals(owner, root, current)).toEqual([
      expect.objectContaining({
        id,
        candidate: expect.objectContaining({ body: 'original content' }),
        evidence: expect.objectContaining({ proposal: 'original evidence' }),
      }),
    ]);
  });

  test('refuses absent identity and a disabled preview before making a root', async () => {
    const home = makeTempDir('station-private-memory-off-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    let enabled = false;
    const manager = new MemoryRootManager(
      store,
      persistence,
      home,
      () => enabled,
    );
    await expect(manager.ensureRoot(owner, current)).rejects.toThrow();
    enabled = true;
    await expect(manager.ensureRoot(undefined, current)).rejects.toThrow();
    const hosted = sessionReadAuthorityFromRequest('human:owner', undefined, {
      schemaVersion: 1,
      tenants: [],
      authorityToTenant: {},
    });
    await expect(manager.ensureRoot(hosted, current)).rejects.toThrow();
    expect(await store.listRoots()).toEqual([]);
    expect(existsSync(join(home, 'knowledge', 'memory'))).toBe(false);
  });

  test('refuses a forged shared registration for the memory adapter', async () => {
    const home = makeTempDir('station-private-memory-forged-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    new MemoryRootManager(store, persistence, home, () => true);
    await persistence.saveKnowledgeStoreRoot(
      {
        id: 'root:forged-memory',
        scope: { kind: 'personal' },
        adapterId: MEMORY_ADAPTER_ID,
        storeRoot: join(home, 'memory'),
        displayName: 'Forged',
        createdAt: new Date().toISOString(),
      },
      { createOnly: true },
    );
    await expect(store.adapterFor('root:forged-memory')).rejects.toThrow(
      'registration is invalid',
    );
  });

  test('the ordinary root routes cannot offer or register the memory adapter as shared', async () => {
    const home = makeTempDir('station-private-memory-routes-');
    vi.stubEnv('STATION_HOME', home);
    const persistence = new FileStorageAdapter(home);
    const store = new KnowledgeStoreProvider(persistence);
    new MemoryRootManager(store, persistence, home, () => true);
    const app = createKnowledgeStoreRoutes({
      store,
      dataDir: home,
      mayRegisterRoot: () => true,
    });
    const listed = (await (await app.request('/adapters')).json()) as {
      data: { id: string }[];
    };
    expect(listed.data.map((item) => item.id)).not.toContain(MEMORY_ADAPTER_ID);
    const response = await app.request('/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'personal' },
        adapterId: MEMORY_ADAPTER_ID,
      }),
    });
    expect(response.status).toBe(403);
    expect(await store.listRoots()).toEqual([]);
  });
});
