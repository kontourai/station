import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods, so
 * this test exercises the provider's logic without a full FileStorageAdapter. */
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
    // Mirrors FileStorageAdapter.removeKnowledgeStoreRoot's throw-on-unknown-id
    // behavior — every other id-keyed remove op in that file (provider connections,
    // projects, layouts, templates) throws "not found" rather than no-op'ing, and
    // this fake must agree with the real adapter so callers see one contract.
    const index = this.roots.findIndex((r) => r.id === id);
    if (index < 0) throw new Error(`Knowledge store root '${id}' not found`);
    this.roots.splice(index, 1);
  }
}

describe('KnowledgeStoreProvider', () => {
  let personalDir: string;
  let projectDir: string;
  let persistence: FakeRootPersistence;
  let provider: KnowledgeStoreProvider;

  beforeEach(() => {
    personalDir = mkdtempSync(join(tmpdir(), 'knowledge-store-personal-'));
    projectDir = mkdtempSync(join(tmpdir(), 'knowledge-store-project-'));
    persistence = new FakeRootPersistence();
    provider = new KnowledgeStoreProvider(persistence);
  });

  afterEach(() => {
    rmSync(personalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('pre-registers both Station-owned Kit-format adapters', () => {
    const adapters = provider.listAdapters();
    expect(adapters.map((a) => a.id)).toEqual(
      expect.arrayContaining(['kit-default-store', 'kit-obsidian-store']),
    );
  });

  test('personal + project roots coexist, each independently backed and isolated on disk', async () => {
    const personalRoot = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: personalDir,
      displayName: 'Personal knowledge',
    });
    const projectRoot = await provider.createRoot({
      scope: { kind: 'project', projectSlug: 'acme' },
      adapterId: 'kit-default-store',
      storeRoot: projectDir,
      displayName: 'Acme knowledge',
    });

    expect(personalRoot.id).not.toBe(projectRoot.id);

    const roots = await provider.listRoots();
    expect(roots).toHaveLength(2);

    const personalAdapter = await provider.adapterFor(personalRoot.id);
    const projectAdapter = await provider.adapterFor(projectRoot.id);
    expect(personalAdapter).not.toBe(projectAdapter);

    const personalRecordId = await personalAdapter.create({
      type: 'raw',
      title: 'Personal note',
      body: 'b',
      category: 'personal',
      provenance: { agent: 'agent-1' },
    });
    const projectRecordId = await projectAdapter.create({
      type: 'raw',
      title: 'Project note',
      body: 'b',
      category: 'project',
      provenance: { agent: 'agent-1' },
    });

    // Isolation: a record created in one root's adapter never appears in the other's.
    expect(await personalAdapter.get(projectRecordId)).toBeNull();
    expect(await projectAdapter.get(personalRecordId)).toBeNull();
    expect(
      existsSync(join(personalDir, 'records', `${personalRecordId}.md`)),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, 'records', `${personalRecordId}.md`)),
    ).toBe(false);
  });

  test('AC2: personal + project roots coexist across DIFFERENT adapters (kit-default-store + kit-obsidian-store), each independently backed and isolated on disk', async () => {
    const personalRoot = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: personalDir,
      displayName: 'Personal knowledge (default store)',
    });
    const projectRoot = await provider.createRoot({
      scope: { kind: 'project', projectSlug: 'acme' },
      adapterId: 'kit-obsidian-store',
      storeRoot: projectDir,
      displayName: 'Acme knowledge (Obsidian vault)',
    });

    const personalAdapter = await provider.adapterFor(personalRoot.id);
    const projectAdapter = await provider.adapterFor(projectRoot.id);
    expect(personalAdapter).not.toBe(projectAdapter);

    const personalRecordId = await personalAdapter.create({
      type: 'raw',
      title: 'Personal note',
      body: 'b',
      category: 'personal',
      provenance: { agent: 'agent-1' },
    });
    const projectRecordId = await projectAdapter.create({
      type: 'concept',
      title: 'Project concept',
      body: 'b',
      category: 'project',
      provenance: { agent: 'agent-1' },
    });

    // Isolation: a record created via one root's adapter never appears via the
    // other's, and each adapter's own on-disk layout is used (flat records/<id>.md
    // for the default store; category-path-routed for the Obsidian vault) —
    // operations on one root never touch another root's files, regardless of
    // whether the two roots share an adapter or not.
    expect(await personalAdapter.get(projectRecordId)).toBeNull();
    expect(await projectAdapter.get(personalRecordId)).toBeNull();
    expect(
      existsSync(join(personalDir, 'records', `${personalRecordId}.md`)),
    ).toBe(true);
    expect(
      existsSync(join(projectDir, 'records', `${personalRecordId}.md`)),
    ).toBe(false);
    expect(existsSync(join(projectDir, 'project', 'project-concept.md'))).toBe(
      true,
    );
    expect(existsSync(join(personalDir, 'project', 'project-concept.md'))).toBe(
      false,
    );
  });

  test('adapterFor caches one adapter instance per root', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: personalDir,
      displayName: 'Personal knowledge',
    });

    const first = await provider.adapterFor(root.id);
    const second = await provider.adapterFor(root.id);
    expect(first).toBe(second);
  });

  test('onRecordsChanged fires exactly once per mutation with the correct rootId/recordIds', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: personalDir,
      displayName: 'Personal knowledge',
    });
    const adapter = await provider.adapterFor(root.id);

    const events: Array<{ rootId: string; recordIds: string[] }> = [];
    const unsubscribe = provider.onRecordsChanged((event) =>
      events.push(event),
    );

    const id = await adapter.create({
      type: 'raw',
      title: 'T',
      body: 'b',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ rootId: root.id, recordIds: [id] });

    await adapter.update(id, { title: 'T2' }, { agent: 'agent-1' });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ rootId: root.id, recordIds: [id] });

    unsubscribe();
    await adapter.update(id, { title: 'T3' }, { agent: 'agent-1' });
    expect(events).toHaveLength(2); // no further events after unsubscribe
  });

  test('removeRoot deregisters only — the store directory and its files survive on disk', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: personalDir,
      displayName: 'Personal knowledge',
    });
    const adapter = await provider.adapterFor(root.id);
    const id = await adapter.create({
      type: 'raw',
      title: 'Survives removal',
      body: 'b',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const recordPath = join(personalDir, 'records', `${id}.md`);
    expect(existsSync(recordPath)).toBe(true);

    await provider.removeRoot(root.id);

    expect(await provider.getRoot(root.id)).toBeNull();
    expect(await provider.listRoots()).toHaveLength(0);
    // Deregistration only — never deletes store files.
    expect(existsSync(recordPath)).toBe(true);
    expect(existsSync(personalDir)).toBe(true);
  });

  test("removeRoot rejects for an unknown root id (matches FileStorageAdapter's throw-on-unknown-id convention)", async () => {
    await expect(provider.removeRoot('root:does-not-exist')).rejects.toThrow(
      /not found/i,
    );
  });

  test('registering a duplicate adapterId extends (last-write-wins), not throws', () => {
    const first = {
      id: 'kit-default-store',
      displayName: 'First',
      create: async (_opts: { storeRoot: string }) => {
        throw new Error('should not be used');
      },
    };
    expect(() => provider.registerAdapter(first)).not.toThrow();
    const adapters = provider.listAdapters();
    const match = adapters.find((a) => a.id === 'kit-default-store');
    expect(match?.displayName).toBe('First');
  });

  test('adapterFor throws a clear error for an unknown root or unregistered adapter', async () => {
    await expect(provider.adapterFor('root:does-not-exist')).rejects.toThrow(
      /not found/i,
    );

    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-unregistered-adapter',
      storeRoot: personalDir,
      displayName: 'Personal knowledge',
    });
    await expect(provider.adapterFor(root.id)).rejects.toThrow(
      /not registered/i,
    );
  });

  describe('validateRootForAdapter', () => {
    test('known adapter WITH a validateRoot hook (kit-obsidian-store): honest ok:false for an empty dir with no .obsidian/ marker', async () => {
      const result = await provider.validateRootForAdapter(
        'kit-obsidian-store',
        projectDir,
      );
      expect(result).toEqual({
        ok: false,
        reason:
          'storeRoot is an empty directory with no .obsidian/ vault marker',
      });
    });

    test('known adapter WITH a validateRoot hook (kit-obsidian-store): ok:true for a dir containing .obsidian/', async () => {
      mkdirSync(join(projectDir, '.obsidian'));
      const result = await provider.validateRootForAdapter(
        'kit-obsidian-store',
        projectDir,
      );
      expect(result).toEqual({ ok: true });
    });

    test('known adapter WITHOUT a validateRoot hook (kit-default-store) is trivially ok:true', async () => {
      const result = await provider.validateRootForAdapter(
        'kit-default-store',
        personalDir,
      );
      expect(result).toEqual({ ok: true });
    });

    test('unknown adapterId returns ok:false with a named reason, never a throw', async () => {
      const result = await provider.validateRootForAdapter(
        'kit-unregistered-adapter',
        personalDir,
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/unknown/i);
      expect(result.reason).toMatch(/kit-unregistered-adapter/);
    });
  });
});
