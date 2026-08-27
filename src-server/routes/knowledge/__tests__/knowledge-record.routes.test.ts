import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KitRecord,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { ReadOnlyStoreError } from '../../../knowledge-store/errors.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeRecordRoutes } from '../knowledge-record-routes.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods -
 * same fixture shape used by knowledge-store.routes.test.ts and
 * knowledge-index.routes.test.ts. */
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

describe('knowledge-record routes', () => {
  let storeDir: string;
  let persistence: FakeRootPersistence;
  let store: KnowledgeStoreProvider;
  let rootId: string;

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'knowledge-record-routes-store-'));
    persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
    const root = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: storeDir,
      displayName: 'Personal knowledge',
    });
    rootId = root.id;
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  function routesApp() {
    return createKnowledgeRecordRoutes({ store });
  }

  async function createRecord(
    app: ReturnType<typeof routesApp>,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await app.request(`/roots/${rootId}/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'raw',
        title: 'Meeting transcript',
        body: 'raw transcript body',
        category: 'meeting-notes',
        provenance: { agent: 'station.meeting-notes.capture' },
        ...overrides,
      }),
    });
    const body = await readJson<{ success: boolean; data: KitRecord }>(res);
    return { res, body };
  }

  describe('create -> get -> link -> listByType round trip', () => {
    test('create writes a raw record, get resolves it, listByType lists it, link connects it to a compiled record', async () => {
      const app = routesApp();

      const { res: createRes, body: createBody } = await createRecord(app);
      expect(createRes.status).toBe(201);
      expect(createBody.success).toBe(true);
      expect(createBody.data.type).toBe('raw');
      expect(createBody.data.title).toBe('Meeting transcript');
      const rawId = createBody.data.id;

      // get
      const getRes = await app.request(`/roots/${rootId}/records/${rawId}`);
      const getBody = await readJson<{ success: boolean; data: KitRecord }>(
        getRes,
      );
      expect(getRes.status).toBe(200);
      expect(getBody.data.id).toBe(rawId);
      expect(getBody.data.body).toBe('raw transcript body');

      // listByType
      const listRes = await app.request(`/roots/${rootId}/records?type=raw`);
      const listBody = await readJson<{ success: boolean; data: KitRecord[] }>(
        listRes,
      );
      expect(listRes.status).toBe(200);
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0].id).toBe(rawId);

      // create the compiled record with a provenance source link, then link it
      const { body: compiledBody } = await createRecord(app, {
        type: 'compiled',
        title: 'Meeting notes',
        body: 'compiled summary',
        category: 'meeting-notes',
        provenance: {
          agent: 'station.meeting-notes.compile',
          source_ids: [rawId],
        },
      });
      const compiledId = compiledBody.data.id;

      const linkRes = await app.request(
        `/roots/${rootId}/records/${compiledId}/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            links: [{ target_id: rawId, kind: 'source' }],
            evidence: { agent: 'station.meeting-notes.compile' },
          }),
        },
      );
      const linkBody = await readJson<{ success: boolean; data: KitRecord }>(
        linkRes,
      );
      expect(linkRes.status).toBe(200);
      expect(linkBody.data.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target_id: rawId, kind: 'source' }),
        ]),
      );

      // listByType for compiled shows exactly the compiled record, with the link.
      const compiledListRes = await app.request(
        `/roots/${rootId}/records?type=compiled`,
      );
      const compiledListBody = await readJson<{
        success: boolean;
        data: KitRecord[];
      }>(compiledListRes);
      expect(compiledListBody.data).toHaveLength(1);
      expect(compiledListBody.data[0].links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target_id: rawId, kind: 'source' }),
        ]),
      );
    });
  });

  describe('POST /roots/:rootId/records validation', () => {
    test('missing required fields -> 400', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'raw' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
    });

    test('unknown type -> 400', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'not-a-real-type',
          title: 't',
          body: 'b',
          category: 'meeting-notes',
          provenance: { agent: 'test' },
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/type/i);
    });

    test('a traversal-shaped id in the body is rejected with 400, never reaching the adapter (SEC-1)', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: '../../../evil',
          type: 'raw',
          title: 't',
          body: 'b',
          category: 'meeting-notes',
          provenance: { agent: 'test' },
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/id/i);
    });

    test('a traversal-shaped links[].target_id in the body is rejected with 400 (SEC-1)', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'raw',
          title: 't',
          body: 'b',
          category: 'meeting-notes',
          provenance: { agent: 'test' },
          links: [{ target_id: '../../etc/passwd', kind: 'source' }],
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/target_id/i);
    });

    test('missing provenance.agent -> 400', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'raw',
          title: 't',
          body: 'b',
          category: 'meeting-notes',
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/provenance/i);
    });

    test('an invalid rootId shape -> 400', async () => {
      const app = routesApp();
      const res = await app.request(
        `/roots/${encodeURIComponent('bad\u0000id')}/records`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'raw',
            title: 't',
            body: 'b',
            category: 'meeting-notes',
            provenance: { agent: 'test' },
          }),
        },
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/rootId/i);
    });
  });

  describe('GET /roots/:rootId/records/:id', () => {
    test('a traversal-shaped id path param is rejected with 400, never reaching the adapter (SEC-1)', async () => {
      const app = routesApp();
      const res = await app.request(
        `/roots/${rootId}/records/${encodeURIComponent('../../../etc/passwd')}`,
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/id/i);
    });

    test('an unknown but safe-shaped id -> 404, not 500', async () => {
      const app = routesApp();
      const res = await app.request(
        `/roots/${rootId}/records/does-not-exist-00000000`,
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
    });
  });

  describe('GET /roots/:rootId/records (listByType)', () => {
    test('missing type query param -> 400', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records`);
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/type/i);
    });

    test('empty root returns an empty list for a valid type, not an error', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/records?type=raw`);
      const body = await readJson<{ success: boolean; data: KitRecord[] }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toEqual([]);
    });
  });

  describe('POST /roots/:rootId/records/:id/links', () => {
    test('linking to a nonexistent target -> 404 (NOT_FOUND passthrough, not a generic 500)', async () => {
      const app = routesApp();
      const { body: createBody } = await createRecord(app);
      const sourceId = createBody.data.id;

      const res = await app.request(
        `/roots/${rootId}/records/${sourceId}/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            links: [{ target_id: 'does-not-exist-00000000', kind: 'source' }],
            evidence: { agent: 'test' },
          }),
        },
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('missing evidence.agent -> 400', async () => {
      const app = routesApp();
      const { body: createBody } = await createRecord(app);
      const sourceId = createBody.data.id;

      const res = await app.request(
        `/roots/${rootId}/records/${sourceId}/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            links: [{ target_id: sourceId, kind: 'source' }],
          }),
        },
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/evidence/i);
    });
  });

  describe('GET /roots/:rootId/graph', () => {
    test('a root with two linked records renders >=2 nodes and >=1 edge', async () => {
      const app = routesApp();
      const { body: rawBody } = await createRecord(app);
      const rawId = rawBody.data.id;
      const { body: compiledBody } = await createRecord(app, {
        type: 'compiled',
        title: 'Meeting notes',
        body: 'compiled summary',
        category: 'meeting-notes',
        links: [{ target_id: rawId, kind: 'source' }],
        provenance: {
          agent: 'station.meeting-notes.compile',
          source_ids: [rawId],
        },
      });
      const compiledId = compiledBody.data.id;

      const res = await app.request(`/roots/${rootId}/graph`);
      const body = await readJson<{
        success: boolean;
        data: {
          nodes: Array<{ id: string; type: string }>;
          edges: Array<{ source: string; target: string; kind: string }>;
        };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.nodes.length).toBeGreaterThanOrEqual(2);
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

    test('an empty root returns an empty graph, not an error', async () => {
      const app = routesApp();
      const res = await app.request(`/roots/${rootId}/graph`);
      const body = await readJson<{
        success: boolean;
        data: { nodes: unknown[]; edges: unknown[] };
      }>(res);
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ nodes: [], edges: [] });
    });
  });

  // station#1879: a read-only projection adapter (e.g. the conversation-history
  // root landed in W2) throws `ReadOnlyStoreError` from every mutation verb. This
  // fake stands in for that adapter shape so the 405 mapping is proven here,
  // independent of the real conversation-store adapter's own test suite.
  describe('a read-only projection adapter -> 405, not a generic 500', () => {
    async function readOnlyRootId(): Promise<string> {
      const readOnlyDescriptor: KnowledgeAdapterDescriptor = {
        id: 'fake-read-only-store',
        displayName: 'Fake read-only store',
        create: async () => ({
          create: async () => {
            throw new ReadOnlyStoreError('create');
          },
          update: async () => {
            throw new ReadOnlyStoreError('update');
          },
          link: async () => {
            throw new ReadOnlyStoreError('link');
          },
          propose: async () => {
            throw new ReadOnlyStoreError('propose');
          },
          apply: async () => {
            throw new ReadOnlyStoreError('apply');
          },
          reject: async () => {
            throw new ReadOnlyStoreError('reject');
          },
          supersede: async () => {
            throw new ReadOnlyStoreError('supersede');
          },
          retire: async () => {
            throw new ReadOnlyStoreError('retire');
          },
          get: async () => null,
          getLinks: async () => ({ forward: [], reverse: [] }),
          listByCategory: async () => [],
          listByType: async () => [],
        }),
      };
      store.registerAdapter(readOnlyDescriptor);
      const readOnlyStoreDir = mkdtempSync(
        join(tmpdir(), 'knowledge-record-routes-readonly-'),
      );
      const root = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'fake-read-only-store',
        storeRoot: readOnlyStoreDir,
        displayName: 'Fake read-only store',
      });
      return root.id;
    }

    test('POST /roots/:rootId/records -> 405', async () => {
      const app = routesApp();
      const readOnlyId = await readOnlyRootId();
      const res = await app.request(`/roots/${readOnlyId}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'raw',
          title: 't',
          body: 'b',
          category: 'conversation',
          provenance: { agent: 'test' },
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(405);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/read-only/i);
    });

    test('POST /roots/:rootId/records/:id/links -> 405', async () => {
      const app = routesApp();
      const readOnlyId = await readOnlyRootId();
      const res = await app.request(
        `/roots/${readOnlyId}/records/some-id-00000000/links`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            links: [{ target_id: 'some-id-00000000', kind: 'source' }],
            evidence: { agent: 'test' },
          }),
        },
      );
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(405);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/read-only/i);
    });
  });

  test('corrupt retained transaction authority fails closed with stable 503 copy', async () => {
    const app = routesApp();
    const { body: created } = await createRecord(app);
    writeFileSync(
      join(storeDir, '.station-knowledge-transaction.json'),
      '{operator detail that must not cross the route',
      'utf8',
    );

    const response = await app.request(
      `/roots/${rootId}/records/${created.data.id}`,
    );
    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      success: false,
      error:
        'Knowledge store is unavailable until its persisted state is repaired.',
    });
  });
});
