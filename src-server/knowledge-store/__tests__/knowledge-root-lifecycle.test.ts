import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createKnowledgeStoreRoutes } from '../../routes/knowledge/knowledge-store-routes.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

describe('knowledge source registry lifecycle on real storage', () => {
  let home: string;
  let persistence: FileStorageAdapter;
  let store: KnowledgeStoreProvider;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-source-lifecycle-'));
    persistence = new FileStorageAdapter(home);
    store = new KnowledgeStoreProvider(persistence);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  test('concurrent providers preserve both source registrations', async () => {
    const other = new KnowledgeStoreProvider(new FileStorageAdapter(home));
    const [first, second] = await Promise.all([
      store.createRoot({
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: join(home, 'first'),
        displayName: 'First',
      }),
      other.createRoot({
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: join(home, 'second'),
        displayName: 'Second',
      }),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(await store.listRoots()).toEqual(
      expect.arrayContaining([first, second]),
    );
    expect(await store.listRoots()).toHaveLength(2);
  });

  test('stale disconnect preserves a replacement; exact disconnect preserves source files', async () => {
    const file = join(home, 'source.md');
    writeFileSync(file, 'Retained original');
    const original = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: home,
      displayName: 'Original',
    });
    const replacement = { ...original, displayName: 'Replacement' };
    await persistence.saveKnowledgeStoreRoot(replacement);
    const app = createKnowledgeStoreRoutes({ store, dataDir: home });
    const disconnect = (expectedRoot: typeof original) =>
      app.request(`/roots/${encodeURIComponent(original.id)}/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRoot }),
      });
    expect((await disconnect(original)).status).toBe(409);
    expect(await store.getRoot(original.id)).toEqual(replacement);
    expect((await disconnect(replacement)).status).toBe(200);
    expect(await store.getRoot(original.id)).toBeNull();
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('Retained original');
  });

  test('disconnect requires an exact reference and current management permission', async () => {
    const root = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: home,
      displayName: 'Private',
    });
    const app = createKnowledgeStoreRoutes({
      store,
      dataDir: home,
      mayReadRoot: () => true,
      mayManageRoot: () => false,
    });
    const url = `/roots/${encodeURIComponent(root.id)}/disconnect`;
    expect((await app.request(url, { method: 'POST' })).status).toBe(400);
    expect(
      (
        await app.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRoot: root }),
        })
      ).status,
    ).toBe(404);
    expect(await store.getRoot(root.id)).toEqual(root);
  });
  test('replacing registered metadata never reuses the former store adapter', async () => {
    const original = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'original'),
      displayName: 'Original',
    });
    const oldAdapter = await store.adapterFor(original.id);
    const oldId = await oldAdapter.create({
      type: 'raw',
      title: 'Old private record',
      body: 'Old private bytes',
      category: 'test',
      provenance: { agent: 'fixture' },
    });
    await persistence.saveKnowledgeStoreRoot({
      ...original,
      storeRoot: join(home, 'replacement'),
      displayName: 'Replacement',
    });
    const replacement = await store.adapterFor(original.id);
    expect(await replacement.get(oldId)).toBeNull();
    const newId = await replacement.create({
      type: 'raw',
      title: 'New record',
      body: 'New bytes',
      category: 'test',
      provenance: { agent: 'fixture' },
    });
    expect(await oldAdapter.get(newId)).toBeNull();
    expect((await oldAdapter.get(oldId))?.body).toBe('Old private bytes');
  });
  test('legacy attachment changes only observed registry ownership and refuses a stale source', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const original = await store.createRoot({
      scope: { kind: 'project', projectSlug: 'legacy' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'legacy-store'),
      displayName: 'Legacy documents',
    });
    const adapter = await store.adapterFor(original.id);
    const recordId = await adapter.create({
      type: 'raw',
      title: 'Retained document',
      body: 'Original document bytes',
      category: 'test',
      provenance: { agent: 'fixture' },
    });
    const app = createKnowledgeStoreRoutes({
      store,
      dataDir: home,
      mayRegisterRoot: () => true,
      projectIdForSlug: (slug) => (slug === 'current' ? projectId : undefined),
    });
    const attach = (expectedRoot: typeof original, targetId = projectId) =>
      app.request(`/roots/${encodeURIComponent(original.id)}/attach-project`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRoot,
          projectSlug: 'current',
          projectId: targetId,
        }),
      });
    expect(
      (await attach(original, '22222222-2222-4222-8222-222222222222')).status,
    ).toBe(409);
    const replaced = { ...original, displayName: 'Updated selection' };
    await persistence.saveKnowledgeStoreRoot(replaced);
    expect((await attach(original)).status).toBe(409);
    expect((await attach(replaced)).status).toBe(200);
    expect(await store.getRoot(original.id)).toMatchObject({
      ...replaced,
      scope: { kind: 'project', projectSlug: 'current' },
      projectId,
      registrationId: expect.any(String),
    });
    expect(
      (await (await store.adapterFor(original.id)).get(recordId))?.body,
    ).toBe('Original document bytes');
    expect((await attach({ ...replaced, projectId })).status).toBe(409);
  });
  test('registration refuses a stale Project selection after real deletion and same-slug replacement', async () => {
    const slug = 'research';
    const firstId = '11111111-1111-4111-8111-111111111111';
    const nextId = '22222222-2222-4222-8222-222222222222';
    const project = {
      id: firstId,
      slug,
      name: 'Research',
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    };
    await persistence.createProject(project);
    const app = createKnowledgeStoreRoutes({
      store,
      dataDir: home,
      mayRegisterRoot: () => true,
      projectIdForSlug: (name) => persistence.getProject(name).id,
    });
    const register = (expectedProjectId?: string) =>
      app.request('/roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: { kind: 'project', projectSlug: slug },
          expectedProjectId,
          adapterId: 'kit-default-store',
          storeRoot: join(home, 'private-selection'),
        }),
      });
    await persistence.deleteProject(slug);
    await persistence.createProject({ ...project, id: nextId });
    expect((await register(firstId)).status).toBe(409);
    expect((await register()).status).toBe(409);
    expect(await store.listRoots()).toEqual([]);
    expect((await register(nextId)).status).toBe(201);
    expect((await store.listRoots())[0]?.projectId).toBe(nextId);
    const managed = await app.request('/roots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'project', projectSlug: slug },
        expectedProjectId: nextId,
        adapterId: 'kit-default-store',
      }),
    });
    expect(managed.status).toBe(201);
    expect((await store.listRoots())[1]?.storeRoot).toBe(
      join(home, 'knowledge', 'projects', nextId, 'store'),
    );
  });
  test('a same-clock reconnect cannot be disconnected by its predecessor reference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
    const input = {
      scope: { kind: 'personal' as const },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'reconnected'),
      displayName: 'Documents',
    };
    const prior = await store.createRoot(input);
    await store.removeRoot(prior.id, prior);
    const current = await store.createRoot(input);
    expect(current.id).toBe(prior.id);
    expect(current.createdAt).toBe(prior.createdAt);
    const app = createKnowledgeStoreRoutes({ store, dataDir: home });
    const stale = await app.request(
      `/roots/${encodeURIComponent(prior.id)}/disconnect`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRoot: prior }),
      },
    );
    expect(stale.status).toBe(409);
    expect(await store.getRoot(current.id)).toEqual(current);
  });
});
