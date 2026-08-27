import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  knowledgeStoreRootOps: { add: vi.fn() },
  knowledgeStoreRecordOps: { add: vi.fn() },
}));

import {
  knowledgeStoreRecordOps,
  knowledgeStoreRootOps,
} from '../../telemetry/metrics.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

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
    this.roots = this.roots.filter((r) => r.id !== id);
  }
}

describe('KnowledgeStoreProvider — OTel instruments (station.knowledge.*)', () => {
  let dir: string;
  let provider: KnowledgeStoreProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-store-metrics-'));
    vi.clearAllMocks();
    provider = new KnowledgeStoreProvider(new FakeRootPersistence());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('root registry operations increment station.knowledge.root.operations', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'project', projectSlug: 'acme' },
      adapterId: 'kit-default-store',
      storeRoot: dir,
      displayName: 'Acme knowledge',
    });
    expect(knowledgeStoreRootOps.add).toHaveBeenCalledWith(1, {
      op: 'create',
      scope: 'project',
    });

    await provider.listRoots();
    expect(knowledgeStoreRootOps.add).toHaveBeenCalledWith(1, { op: 'list' });

    await provider.removeRoot(root.id);
    expect(knowledgeStoreRootOps.add).toHaveBeenCalledWith(1, {
      op: 'remove',
      scope: 'project',
    });
  });

  test('root metric failures cannot rewrite persistence outcomes', async () => {
    vi.mocked(knowledgeStoreRootOps.add).mockImplementation(() => {
      throw new Error('observer unavailable');
    });
    const root = await provider.createRoot({
      scope: { kind: 'project', projectSlug: 'acme' },
      adapterId: 'kit-default-store',
      storeRoot: dir,
      displayName: 'Acme knowledge',
    });

    expect(await provider.listRoots()).toEqual([root]);
    expect(
      await provider.validateRootForAdapter('kit-default-store', dir),
    ).toEqual({ ok: true });
    await expect(provider.removeRoot(root.id)).resolves.toBeUndefined();
    expect(await provider.listRoots()).toEqual([]);
  });

  test('record mutation operations increment station.knowledge.record.operations, labeled by op + adapterId', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: dir,
      displayName: 'Personal knowledge',
    });
    const adapter = await provider.adapterFor(root.id);

    const id = await adapter.create({
      type: 'raw',
      title: 'T',
      body: 'b',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    expect(knowledgeStoreRecordOps.add).toHaveBeenCalledWith(1, {
      op: 'create',
      adapterId: 'kit-default-store',
    });

    await adapter.update(id, { title: 'T2' }, { agent: 'agent-1' });
    expect(knowledgeStoreRecordOps.add).toHaveBeenCalledWith(1, {
      op: 'update',
      adapterId: 'kit-default-store',
    });

    await adapter.retire(id, 'retired', {
      agent: 'agent-1',
      rationale: 'done',
    });
    expect(knowledgeStoreRecordOps.add).toHaveBeenCalledWith(1, {
      op: 'retire',
      adapterId: 'kit-default-store',
    });
  });

  test('a throwing post-commit observer cannot turn an applied record mutation into failure', async () => {
    const root = await provider.createRoot({
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot: dir,
      displayName: 'Personal knowledge',
    });
    provider.onRecordsChanged(() => {
      throw new Error('observer fault');
    });
    const adapter = await provider.adapterFor(root.id);

    const id = await adapter.create({
      type: 'raw',
      title: 'Committed',
      body: 'body',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    await expect(adapter.get(id)).resolves.toMatchObject({
      id,
      title: 'Committed',
    });
  });
});
