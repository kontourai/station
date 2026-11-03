import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createKnowledgeStoreRoutes } from '../../routes/knowledge/knowledge-store-routes.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

const makeTempDir = trackTempDirs();
describe('knowledge source registry lifecycle on real storage', () => {
  let home: string;
  let persistence: FileStorageAdapter;
  let store: KnowledgeStoreProvider;
  beforeEach(() => {
    home = makeTempDir('station-source-lifecycle-');
    persistence = new FileStorageAdapter(home);
    store = new KnowledgeStoreProvider(persistence);
  });
  afterEach(() => {
    vi.useRealTimers();
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

  test.each(['private-first', 'shared-first'] as const)(
    'registry refuses overlapping private and shared roots (%s)',
    async (order) => {
      const directory = join(home, 'memory');
      const privateRoot = {
        id: 'root:private-test',
        scope: { kind: 'personal' as const },
        readPolicy: { kind: 'author-private' as const, ownerId: 'human:owner' },
        adapterId: 'kit-default-store',
        storeRoot: directory,
        displayName: 'Private',
        createdAt: new Date().toISOString(),
      };
      const sharedRoot = {
        id: 'root:shared-test',
        scope: { kind: 'personal' as const },
        adapterId: 'kit-default-store',
        storeRoot: `${directory}/`,
        displayName: 'Shared',
        createdAt: new Date().toISOString(),
      };
      const first = order === 'private-first' ? privateRoot : sharedRoot;
      const second = order === 'private-first' ? sharedRoot : privateRoot;
      await persistence.saveKnowledgeStoreRoot(first, { createOnly: true });
      await expect(
        persistence.saveKnowledgeStoreRoot(second, { createOnly: true }),
      ).rejects.toThrow();
      expect(await store.listRoots()).toEqual([first]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a shared alias retargeted to a private root is refused at adapter access',
    async () => {
      const privateDir = join(home, 'private');
      const publicDir = join(home, 'public');
      const alias = join(home, 'alias');
      mkdirSync(privateDir);
      mkdirSync(publicDir);
      symlinkSync(publicDir, alias, 'dir');
      await store.createRoot({
        scope: { kind: 'personal' },
        readPolicy: { kind: 'author-private', ownerId: 'human:owner' },
        adapterId: 'kit-default-store',
        storeRoot: privateDir,
        displayName: 'Private',
      });
      const shared = await store.createRoot({
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: alias,
        displayName: 'Shared',
      });
      rmSync(alias);
      symlinkSync(privateDir, alias, 'dir');
      await expect(store.adapterFor(shared.id)).rejects.toThrow();
    },
  );

  test('registry overlap check serializes concurrent private and shared registrations', async () => {
    const directory = join(home, 'memory');
    const common = {
      scope: { kind: 'personal' as const },
      adapterId: 'kit-default-store',
      storeRoot: directory,
      createdAt: new Date().toISOString(),
    };
    const results = await Promise.allSettled([
      persistence.saveKnowledgeStoreRoot(
        {
          ...common,
          id: 'root:private',
          displayName: 'Private',
          readPolicy: { kind: 'author-private', ownerId: 'human:owner' },
        },
        { createOnly: true },
      ),
      new FileStorageAdapter(home).saveKnowledgeStoreRoot(
        { ...common, id: 'root:shared', displayName: 'Shared' },
        { createOnly: true },
      ),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await store.listRoots()).toHaveLength(1);
  });

  test('root registration captures its private owner before waiting for the registry lock', async () => {
    const anchor = await store.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'anchor'),
      displayName: 'Anchor',
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = persistence.withKnowledgeStoreRoot(anchor, async () => {
      entered();
      await blocked;
    });
    await started;
    const root = {
      id: 'root:private-captured',
      scope: { kind: 'personal' as const },
      readPolicy: { kind: 'author-private' as const, ownerId: 'human:owner' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'private'),
      displayName: 'Private',
      createdAt: new Date().toISOString(),
    };
    const pending = persistence.saveKnowledgeStoreRoot(root, {
      createOnly: true,
    });
    root.readPolicy.ownerId = 'human:other';
    release();
    await held;
    await pending;
    expect((await store.getRoot(root.id))?.readPolicy).toEqual({
      kind: 'author-private',
      ownerId: 'human:owner',
    });
  });

  test('root registration rechecks authority immediately before publishing', async () => {
    let checks = 0;
    const root = {
      id: 'root:private',
      scope: { kind: 'personal' as const },
      readPolicy: { kind: 'author-private' as const, ownerId: 'human:owner' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'private'),
      displayName: 'Private',
      createdAt: new Date().toISOString(),
    };
    await expect(
      persistence.saveKnowledgeStoreRoot(root, {
        createOnly: true,
        assertCurrent: () => {
          checks += 1;
          if (checks === 2) throw new Error('authority ended');
        },
      }),
    ).rejects.toThrow('authority ended');
    expect(await store.listRoots()).toEqual([]);
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
  test('legacy attachment refuses an author-private root without changing its registration', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const root = await store.createRoot({
      scope: { kind: 'project', projectSlug: 'legacy' },
      readPolicy: { kind: 'author-private', ownerId: 'human:another-owner' },
      adapterId: 'kit-default-store',
      storeRoot: join(home, 'private'),
      displayName: 'Private',
    });
    const app = createKnowledgeStoreRoutes({
      store,
      dataDir: home,
      mayRegisterRoot: () => true,
      projectIdForSlug: () => projectId,
    });
    const response = await app.request(
      `/roots/${encodeURIComponent(root.id)}/attach-project`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRoot: root,
          projectSlug: 'current',
          projectId,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await store.getRoot(root.id)).toEqual(root);
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
