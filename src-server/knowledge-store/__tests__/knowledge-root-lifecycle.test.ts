import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
  afterEach(() => rmSync(home, { recursive: true, force: true }));

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
});
