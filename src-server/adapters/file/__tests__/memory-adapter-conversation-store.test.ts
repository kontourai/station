import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMemoryConversationStore } from '../memory-adapter-conversations.js';
import { MemoryAdapterPaths } from '../memory-adapter-paths.js';

describe('memory conversation store', () => {
  let dir: string;
  let paths: MemoryAdapterPaths;
  let store: ReturnType<typeof createMemoryConversationStore>;
  let logger: { error: ReturnType<typeof vi.fn<Console['error']>> };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-adapter-store-'));
    paths = new MemoryAdapterPaths(dir);
    logger = { error: vi.fn<Console['error']>() };
    store = createMemoryConversationStore({ paths, logger });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('persists, loads, and deletes conversations with cached resource ids', async () => {
    const conversation = {
      id: 'conv-1',
      resourceId: 'agent-1',
      userId: 'user-1',
      title: 'Test',
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await store.persistConversation(conversation as any);

    expect(await store.loadConversationFromDisk(conversation.id)).toEqual(
      conversation,
    );
    expect(await store.resolveResourceId(conversation.id)).toBe('agent-1');

    await store.deleteConversationAssets(
      conversation.resourceId,
      conversation.id,
    );

    expect(
      existsSync(
        paths.getConversationPath(conversation.resourceId, conversation.id),
      ),
    ).toBe(false);
    expect(await store.loadConversationFromDisk(conversation.id)).toBeNull();
  });

  test('loads all conversations for a resource', async () => {
    const conversation = {
      id: 'conv-2',
      resourceId: 'agent-2',
      userId: 'user-2',
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };

    await store.persistConversation(conversation as any);

    expect(await store.listAgentConversations('agent-2')).toEqual([
      conversation,
    ]);
    expect(await store.loadAllConversations()).toEqual([conversation]);
  });

  test('never exposes a partially written conversation to concurrent readers', async () => {
    const base = {
      id: 'conv-race',
      resourceId: 'agent-race',
      userId: 'user-race',
      title: 'Race proof',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await store.persistConversation({
      ...base,
      metadata: { revision: -1 },
    } as any);

    const writes = Array.from({ length: 20 }, (_, revision) =>
      store.persistConversation({
        ...base,
        metadata: { revision, padding: 'x'.repeat(128 * 1024) },
      } as any),
    );
    const reads = Array.from({ length: 80 }, () =>
      store.listAgentConversations('agent-race'),
    );

    const snapshots = await Promise.all(reads);
    await Promise.all(writes);

    const disk = JSON.parse(
      readFileSync(paths.getConversationPath(base.resourceId, base.id), 'utf8'),
    );
    const cached = await store.loadConversationFromDisk(base.id);

    expect(logger.error).not.toHaveBeenCalled();
    expect(snapshots.every((items) => items.length === 1)).toBe(true);
    expect(disk.metadata.revision).toBe(19);
    expect(cached).toEqual(disk);
  });
});
