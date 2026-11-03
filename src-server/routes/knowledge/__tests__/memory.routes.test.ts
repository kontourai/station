import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
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

test('memory routes require the preview and owner, and expose proposals only explicitly', async () => {
  const home = makeTempDir('station-memory-routes-');
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
