import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { createKnowledgeStoreRoutes } from '../knowledge-store-routes.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * same fixture shape used by `knowledge-store-provider.test.ts` and
 * `knowledge-index.routes.test.ts`. */
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

describe('knowledge-store routes', () => {
  let dataDir: string;
  let persistence: FakeRootPersistence;
  let store: KnowledgeStoreProvider;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'knowledge-store-routes-data-'));
    persistence = new FakeRootPersistence();
    store = new KnowledgeStoreProvider(persistence);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function routesApp() {
    return createKnowledgeStoreRoutes({ store, dataDir });
  }

  describe('GET /roots + POST /roots', () => {
    test('list empty -> create personal (default path applied) -> list shows it', async () => {
      const app = routesApp();

      const emptyRes = await app.request('/roots');
      const emptyBody = await readJson<{
        success: boolean;
        data: unknown[];
      }>(emptyRes);
      expect(emptyRes.status).toBe(200);
      expect(emptyBody.success).toBe(true);
      expect(emptyBody.data).toEqual([]);

      const createRes = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
        }),
      });
      const createBody = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(createRes);
      expect(createRes.status).toBe(201);
      expect(createBody.success).toBe(true);
      expect(createBody.data.id).toBe('root:personal');
      expect(createBody.data.storeRoot).toBe(
        join(dataDir, 'knowledge', 'personal'),
      );
      expect(createBody.data.displayName).toBe('Personal knowledge store');

      const listRes = await app.request('/roots');
      const listBody = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot[];
      }>(listRes);
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0].id).toBe('root:personal');
    });

    test('project scope with storeRoot omitted defaults to {dataDir}/projects/<slug>/knowledge-store', async () => {
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: 'acme' },
          adapterId: 'kit-default-store',
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(res);
      expect(res.status).toBe(201);
      expect(body.data.storeRoot).toBe(
        join(dataDir, 'projects', 'acme', 'knowledge-store'),
      );
      expect(body.data.displayName).toBe('acme knowledge store');
    });

    test('create with unknown adapterId -> 400', async () => {
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-nonexistent-store',
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/adapterId/i);
    });

    test('a traversal-shaped projectSlug is rejected with 400, not joined into a filesystem path (SEC-1 precedent)', async () => {
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: '../../../evil' },
          adapterId: 'kit-default-store',
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/projectSlug/i);

      // No root was created, and nothing escaped dataDir.
      const roots = await store.listRoots();
      expect(roots).toHaveLength(0);
    });

    test('an unknown scope.kind is rejected with 400', async () => {
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'org' },
          adapterId: 'kit-default-store',
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/scope/i);
    });

    test('an explicit storeRoot is used verbatim (tilde-expanded), never overridden by the default', async () => {
      const explicitDir = mkdtempSync(
        join(tmpdir(), 'knowledge-store-routes-explicit-'),
      );
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
          storeRoot: explicitDir,
          displayName: 'My custom store',
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(res);
      expect(res.status).toBe(201);
      expect(body.data.storeRoot).toBe(explicitDir);
      expect(body.data.displayName).toBe('My custom store');

      rmSync(explicitDir, { recursive: true, force: true });
    });

    test('a project-scope root with an explicit absolute temp path is created successfully (SEC-K4-1: explicit storeRoot is deliberately scope-agnostic)', async () => {
      const explicitDir = mkdtempSync(
        join(tmpdir(), 'knowledge-store-routes-project-explicit-'),
      );
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: 'acme' },
          adapterId: 'kit-default-store',
          storeRoot: explicitDir,
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(res);
      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.storeRoot).toBe(explicitDir);
      expect(body.data.scope).toEqual({ kind: 'project', projectSlug: 'acme' });

      rmSync(explicitDir, { recursive: true, force: true });
    });

    test('a server-defaulted (not-yet-existing) default-store path still creates successfully (validateRootForAdapter has no failure condition without a validateRoot hook)', async () => {
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(res);
      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
    });

    test("an Obsidian root pointing at a non-existent path is rejected 400 with the adapter's own reason, and no root is created", async () => {
      const parentDir = mkdtempSync(
        join(tmpdir(), 'knowledge-store-routes-obsidian-bad-'),
      );
      const nonExistentDir = join(parentDir, 'does-not-exist');
      const app = routesApp();
      const res = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-obsidian-store',
          storeRoot: nonExistentDir,
        }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('storeRoot does not exist');

      const roots = await store.listRoots();
      expect(roots).toHaveLength(0);

      rmSync(parentDir, { recursive: true, force: true });
    });
  });

  describe('GET /adapters', () => {
    test('returns id/displayName only for both pre-registered adapters', async () => {
      const app = routesApp();
      const res = await app.request('/adapters');
      const body = await readJson<{
        success: boolean;
        data: Array<{ id: string; displayName: string }>;
      }>(res);

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(
        expect.arrayContaining([
          { id: 'kit-default-store', displayName: expect.any(String) },
          { id: 'kit-obsidian-store', displayName: expect.any(String) },
        ]),
      );
      // Never leaks adapter internals (no `create`/`validateRoot` functions).
      for (const adapter of body.data) {
        expect(Object.keys(adapter).sort()).toEqual(['displayName', 'id']);
      }
    });
  });

  describe('POST /roots/validate', () => {
    let vaultDir: string;

    beforeEach(() => {
      vaultDir = mkdtempSync(join(tmpdir(), 'knowledge-store-routes-vault-'));
    });

    afterEach(() => {
      rmSync(vaultDir, { recursive: true, force: true });
    });

    test('an empty dir with no .obsidian/ marker returns the exact honest reason, verbatim, not a rewritten message', async () => {
      const app = routesApp();
      const res = await app.request('/roots/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterId: 'kit-obsidian-store',
          storeRoot: vaultDir,
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: { ok: boolean; reason?: string };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        ok: false,
        reason:
          'storeRoot is an empty directory with no .obsidian/ vault marker',
      });
    });

    test('a dir containing .obsidian/ returns ok:true', async () => {
      mkdirSync(join(vaultDir, '.obsidian'));
      const app = routesApp();
      const res = await app.request('/roots/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterId: 'kit-obsidian-store',
          storeRoot: vaultDir,
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: { ok: boolean; reason?: string };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data).toEqual({ ok: true });
    });

    test('an unknown adapterId is a 200 with ok:false + a named reason, never a route-level 400', async () => {
      const app = routesApp();
      const res = await app.request('/roots/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapterId: 'kit-nonexistent-store',
          storeRoot: vaultDir,
        }),
      });
      const body = await readJson<{
        success: boolean;
        data: { ok: boolean; reason?: string };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.ok).toBe(false);
      expect(body.data.reason).toMatch(/kit-nonexistent-store/);
    });

    test('missing storeRoot in the body is a 400', async () => {
      const app = routesApp();
      const res = await app.request('/roots/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapterId: 'kit-obsidian-store' }),
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/storeRoot/i);
    });
  });

  describe('DELETE /roots/:id', () => {
    test('deletes -> root gone from a subsequent list (deregister only, file survives)', async () => {
      const app = routesApp();
      const createRes = await app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'personal' },
          adapterId: 'kit-default-store',
        }),
      });
      const createBody = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot;
      }>(createRes);
      const rootId = createBody.data.id;

      const deleteRes = await app.request(`/roots/${rootId}`, {
        method: 'DELETE',
      });
      const deleteBody = await readJson<{ success: boolean; data: unknown }>(
        deleteRes,
      );
      expect(deleteRes.status).toBe(200);
      expect(deleteBody.success).toBe(true);

      const listRes = await app.request('/roots');
      const listBody = await readJson<{
        success: boolean;
        data: KnowledgeStoreRoot[];
      }>(listRes);
      expect(listBody.data).toEqual([]);
    });

    test("deleting an unknown root id is a 500 (matches removeRoot's throw-on-unknown-id contract)", async () => {
      const app = routesApp();
      const res = await app.request('/roots/root:does-not-exist', {
        method: 'DELETE',
      });
      const body = await readJson<{ success: boolean; error: string }>(res);
      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/not found/i);
    });
  });
});
