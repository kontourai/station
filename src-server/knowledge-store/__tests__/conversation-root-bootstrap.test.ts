import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { afterEach, describe, expect, test } from 'vitest';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  CONVERSATION_ROOT_ID,
  CONVERSATION_STORE_ADAPTER_ID,
  type ConversationFileStoreReader,
  type ConversationSessionReader,
} from '../adapters/conversation-store.js';
import { ensureConversationKnowledgeRoot } from '../conversation-root-bootstrap.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

/** In-memory fake mirroring the FileStorageAdapter root-persistence methods —
 * same fixture shape used across the knowledge-store test suites — plus a
 * `saveCalls` counter so "zero durable writes" is provable, not just implied
 * by an empty final list. */
class FakeRootPersistence {
  private roots: KnowledgeStoreRoot[] = [];
  saveCalls = 0;

  listKnowledgeStoreRoots(): KnowledgeStoreRoot[] {
    return this.roots.slice();
  }

  saveKnowledgeStoreRoot(root: KnowledgeStoreRoot): void {
    this.saveCalls += 1;
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

function noopSessionReader(): ConversationSessionReader {
  return {
    async listSessionReadModel() {
      return [];
    },
    sessionQueries: {
      read: async () => ({ status: 'not-found' as const }),
      readAssistantTurn: async () => ({ status: 'not-found' as const }),
      readUserInput: async () => ({ status: 'not-found' as const }),
    },
  };
}

function noopFileStores(): Map<string, ConversationFileStoreReader> {
  return new Map();
}

function baseDeps(persistence: FakeRootPersistence) {
  const provider = new KnowledgeStoreProvider(persistence);
  return {
    provider,
    persistence,
    sessionReader: noopSessionReader(),
    fileStores: noopFileStores(),
    getUserId: () => 'user-1',
    projectHomeDir: '/tmp/fake-home',
  };
}

describe('ensureConversationKnowledgeRoot (station#1879)', () => {
  const originalHostedRegistry = process.env[HOSTED_TENANT_REGISTRY_FILE_ENV];

  afterEach(() => {
    if (originalHostedRegistry === undefined) {
      delete process.env[HOSTED_TENANT_REGISTRY_FILE_ENV];
    } else {
      process.env[HOSTED_TENANT_REGISTRY_FILE_ENV] = originalHostedRegistry;
    }
  });

  test('always registers the adapter, flag on or off', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: false,
    });

    expect(
      deps.provider
        .listAdapters()
        .some((d) => d.id === CONVERSATION_STORE_ADAPTER_ID),
    ).toBe(true);
  });

  test('flag off -> adapter registered but zero durable writes', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: false,
    });

    expect(persistence.saveCalls).toBe(0);
    expect(persistence.listKnowledgeStoreRoots()).toEqual([]);
    expect(await deps.provider.getRoot(CONVERSATION_ROOT_ID)).toBeNull();
  });

  test('hosted mode suppresses the unbound conversation projection entirely', async () => {
    process.env[HOSTED_TENANT_REGISTRY_FILE_ENV] = '/deployment/tenants.json';
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });

    expect(persistence.saveCalls).toBe(0);
    expect(await deps.provider.getRoot(CONVERSATION_ROOT_ID)).toBeNull();
    expect(
      deps.provider
        .listAdapters()
        .some((adapter) => adapter.id === CONVERSATION_STORE_ADAPTER_ID),
    ).toBe(false);
  });

  test('flag undefined behaves identically to flag off (default-off, byte-identical)', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: undefined,
    });

    expect(persistence.saveCalls).toBe(0);
  });

  test('flag on -> creates the root exactly once, at the stable id, personal scope', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });

    const root = await deps.provider.getRoot(CONVERSATION_ROOT_ID);
    expect(root).not.toBeNull();
    expect(root?.id).toBe(CONVERSATION_ROOT_ID);
    expect(root?.adapterId).toBe(CONVERSATION_STORE_ADAPTER_ID);
    expect(root?.scope).toEqual({ kind: 'personal' });
    expect(persistence.saveCalls).toBe(1);
  });

  test('idempotency: calling ensure twice with the flag on still yields exactly one root and one write', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });
    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });

    expect(
      persistence
        .listKnowledgeStoreRoots()
        .filter((r) => r.id === CONVERSATION_ROOT_ID),
    ).toHaveLength(1);
    // The second call's `getRoot` found an existing root and skipped the
    // write entirely — not just "still exactly one row after an upsert".
    expect(persistence.saveCalls).toBe(1);
  });

  test('delete-then-ensure recreates the root', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });
    expect(await deps.provider.getRoot(CONVERSATION_ROOT_ID)).not.toBeNull();

    await deps.provider.removeRoot(CONVERSATION_ROOT_ID);
    expect(await deps.provider.getRoot(CONVERSATION_ROOT_ID)).toBeNull();

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });
    const recreated = await deps.provider.getRoot(CONVERSATION_ROOT_ID);
    expect(recreated).not.toBeNull();
    expect(recreated?.id).toBe(CONVERSATION_ROOT_ID);
    expect(persistence.saveCalls).toBe(2);
  });

  test('the documentary storeRoot is the orchestration database path', async () => {
    const persistence = new FakeRootPersistence();
    const deps = baseDeps(persistence);

    await ensureConversationKnowledgeRoot({
      ...deps,
      knowledgeStoresEnabled: true,
    });

    const root = await deps.provider.getRoot(CONVERSATION_ROOT_ID);
    expect(root?.storeRoot).toBe('/tmp/fake-home/data/orchestration.sqlite');
  });
});
