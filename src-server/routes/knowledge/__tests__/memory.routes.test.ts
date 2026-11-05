import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { MemoryErasureCoordinator } from '../../../knowledge-store/memory-erasure-coordinator.js';
import { MemoryRootManager } from '../../../knowledge-store/memory-root.js';
import { createMemoryRoutes } from '../memory-routes.js';

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
afterEach(() => vi.unstubAllEnvs());

test('erasure route requires owner confirmation and returns the actual proposal receipt', async () => {
  const home = makeTempDir('station-memory-erase-route-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  let enabled = true;
  const manager = new MemoryRootManager(
    store,
    persistence,
    home,
    () => enabled,
  );
  const index = new SqliteVecIndexProvider({ dbPath: join(home, 'index.db') });
  const erasure = new MemoryErasureCoordinator(home, store, manager, index);
  const app = createMemoryRoutes({
    manager,
    erasure,
    enabled: () => enabled,
    authority: (request, action) => {
      const user = request.headers.get('x-test-user');
      if (
        user !== 'owner' ||
        (action === 'create' && request.headers.get('x-test-agent') === 'yes')
      )
        return undefined;
      return {
        scope: owner,
        assertCurrent: () => {
          if (!enabled) throw new Error('disabled');
        },
      };
    },
    mayReadRoot: async () => true,
    guardReadResponse: async (_request, _roots, response) => response,
  });
  try {
    const root = await manager.ensureRoot(owner, () => {});
    const id = await manager.propose(
      owner,
      root,
      () => {},
      {
        type: 'raw',
        title: 'Private',
        body: 'private body',
        category: 'memory',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      'proposal',
    );
    const preview = await manager.previewErasureTarget(
      owner,
      root,
      () => {},
      'proposal',
      id,
    );
    if (!preview) throw new Error('Expected preview');
    const payload = {
      kind: 'proposal',
      id,
      revision: preview.impact.revision,
      purgeId: '70b9f66a-7b4f-49e2-97ae-839964b0ad37',
    };
    const request = (user: string, agent = false) =>
      app.request('/memory/erase', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-user': user,
          ...(agent ? { 'x-test-agent': 'yes' } : {}),
        },
        body: JSON.stringify(payload),
      });
    expect((await request('other')).status).toBe(403);
    expect((await request('owner', true)).status).toBe(403);
    enabled = false;
    expect((await request('owner')).status).toBe(404);
    enabled = true;
    const response = await request('owner');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        receipt: {
          kind: 'proposal',
          result: { proposalId: id, alreadyErased: false },
        },
      },
    });
    expect(
      (await manager.listProposals(owner, root, () => {}))[0].erasure,
    ).toBeDefined();
    const retry = await request('owner');
    expect(await retry.json()).toMatchObject({
      success: true,
      data: { receipt: { kind: 'proposal', result: { proposalId: id } } },
    });
  } finally {
    index.close();
  }
});

test('memory routes require the preview and owner, and expose proposals only explicitly', async () => {
  const home = makeTempDir('station-memory-routes-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  let enabled = false;
  let allowRead = true;
  const manager = new MemoryRootManager(
    store,
    persistence,
    home,
    () => enabled,
  );
  const app = createMemoryRoutes({
    manager,
    enabled: () => enabled,
    authority: (request, action) => {
      const name = request.headers.get('x-test-user');
      const scope =
        name === 'owner' ? owner : name === 'other' ? other : undefined;
      if (!scope || (action === 'create' && name !== 'owner')) return undefined;
      return {
        scope,
        assertCurrent: () => {
          if (!enabled) throw new Error('disabled');
        },
      };
    },
    mayReadRoot: async (request, root) =>
      allowRead &&
      request.headers.get('x-test-user') === 'owner' &&
      root.readPolicy?.ownerId === owner.userId,
    guardReadResponse: async (_request, _roots, response) => response,
  });
  const headers = {
    'x-test-user': 'owner',
    'content-type': 'application/json',
  };
  const off = await app.request('/memory/root', { method: 'POST', headers });
  expect(off.status).toBe(404);
  expect(await off.json()).toMatchObject({
    code: 'feature_preview_disabled',
    previewId: 'private-memory',
  });
  expect(await store.listRoots()).toEqual([]);
  enabled = true;
  const created = await app.request('/memory/root', {
    method: 'POST',
    headers,
  });
  expect(created.status).toBe(200);
  const root = ((await created.json()) as { data: { id: string } }).data;
  const input = {
    requestKey: 'opaque-request-1',
    candidate: {
      type: 'raw',
      title: 'Proposed',
      body: 'private proposal',
      category: 'memory',
      provenance: {
        agent: 'test',
        source_refs: [
          {
            kind: 'session-transcript',
            harness: 'test',
            session_id: 'session-1',
            transcript_ref: 'transcript-1',
            range: { start: 2, end: 4 },
          },
        ],
      },
    },
    evidence: { agent: 'test', proposal: 'evidence' },
  };
  const proposed = await app.request('/memory/proposals', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  expect(proposed.status).toBe(201);
  const id = ((await proposed.json()) as { data: { id: string } }).data.id;
  expect(
    (
      await app.request(
        '/memory/erasure-preview?kind=record&id=..%2F..%2Fsecret',
        { headers },
      )
    ).status,
  ).toBe(400);
  const preview = await app.request(
    `/memory/erasure-preview?kind=proposal&id=${id}`,
    { headers },
  );
  expect(await preview.json()).toEqual({
    success: true,
    data: {
      kind: 'proposal',
      id,
      title: 'Proposed',
      impact: expect.objectContaining({
        proposalId: id,
        state: 'pending',
        alreadyErased: false,
        revision: expect.any(String),
      }),
    },
  });
  allowRead = false;
  expect(
    (
      await app.request(`/memory/erasure-preview?kind=proposal&id=${id}`, {
        headers,
      })
    ).status,
  ).toBe(404);
  allowRead = true;
  expect(
    (
      await app.request(`/memory/erasure-preview?kind=proposal&id=${id}`, {
        headers: { 'x-test-user': 'other' },
      })
    ).status,
  ).toBe(404);
  expect(
    (await app.request(`/memory/erasure-preview?kind=proposal&id=${id}`))
      .status,
  ).toBe(403);
  const registeredRoot = await manager.findRoot(owner, () => {});
  expect(registeredRoot).not.toBeNull();
  await expect(
    manager.applyCreate(owner, registeredRoot!, () => {}, id),
  ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
  const replay = await app.request('/memory/proposals', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  expect(((await replay.json()) as { data: { id: string } }).data.id).toBe(id);
  const conflict = await app.request('/memory/proposals', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...input,
      candidate: { ...input.candidate, body: 'different' },
    }),
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'REQUEST_KEY_CONFLICT' });
  const oversized = await app.request('/memory/proposals', {
    method: 'POST',
    headers,
    body: 'x'.repeat(1024 * 1024 + 1),
  });
  expect(oversized.status).toBe(413);
  const listed = await app.request('/memory/proposals', { headers });
  expect(await listed.json()).toMatchObject({
    success: true,
    data: [
      {
        id,
        state: 'pending',
        candidate: { provenance: input.candidate.provenance },
      },
    ],
  });
  const adapter = await store.adapterFor(root.id);
  expect(await adapter.listByType('raw', { includeRetired: true })).toEqual([]);
  expect(await adapter.get(id)).toBeNull();
  expect(
    (
      await app.request('/memory/proposals', {
        headers: { 'x-test-user': 'other' },
      })
    ).status,
  ).toBe(404);
  expect((await app.request('/memory/proposals')).status).toBe(403);
  expect(
    (
      await app.request('/memory/proposals', {
        method: 'POST',
        headers: { 'x-test-user': 'other' },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(403);
  enabled = false;
  expect((await app.request('/memory/proposals', { headers })).status).toBe(
    404,
  );
  await expect(adapter.listByType('raw')).rejects.toThrow();
});
