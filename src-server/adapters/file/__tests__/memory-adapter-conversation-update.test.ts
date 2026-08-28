/**
 * archive#1566 review (HIGH): `FileMemoryAdapter.updateConversation` used to
 * do a separate outer read, decide, then write — a classic TOCTOU. These
 * tests exercise the real adapter against a real (temp-dir) filesystem to
 * prove the fix: the entire read-compute-write now runs inside the same
 * per-conversation serialized queue `persistConversation` already used, so a
 * concurrent update can never be computed from a stale snapshot, and an
 * updater that returns `null` skips the write entirely.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileMemoryAdapter } from '../memory-adapter.js';

describe('FileMemoryAdapter.updateConversation (station#1566 review HIGH)', () => {
  let projectHomeDir: string;
  let adapter: FileMemoryAdapter;

  beforeEach(async () => {
    projectHomeDir = await mkdtemp(
      join(tmpdir(), 'station-memory-adapter-update-'),
    );
    adapter = new FileMemoryAdapter({ projectHomeDir });
  });

  afterEach(async () => {
    await rm(projectHomeDir, { recursive: true, force: true });
  });

  test("an updater-form call started right after an object-form call observes the object-form call's committed write, never a stale pre-queue snapshot", async () => {
    await adapter.createConversation({
      id: 'c1',
      resourceId: 'agent-a',
      userId: 'u1',
      title: 'Initial',
      metadata: {},
    });

    const observedByUpdater: unknown[] = [];
    // Fired back-to-back with no `await` between them: both calls'
    // synchronous prefix (predecessor lookup, queue registration) runs
    // before either's write actually happens, exactly the scenario the
    // per-conversation queue exists to serialize.
    const objectFormWrite = adapter.updateConversation('c1', {
      title: 'Renamed by object-form call',
      metadata: { source: 'object-form' },
    });
    const updaterFormWrite = adapter.updateConversation('c1', (current) => {
      observedByUpdater.push(current.title);
      return {
        title: `${current.title} + updater-form`,
        metadata: { ...current.metadata, source: 'updater-form' },
      };
    });

    const [, updaterResult] = await Promise.all([
      objectFormWrite,
      updaterFormWrite,
    ]);

    // The updater must have seen the OTHER call's already-committed title —
    // never the original "Initial" snapshot from before either call queued.
    expect(observedByUpdater).toEqual(['Renamed by object-form call']);
    expect(updaterResult.title).toBe(
      'Renamed by object-form call + updater-form',
    );
    expect(updaterResult.metadata).toMatchObject({ source: 'updater-form' });

    const reloaded = await adapter.getConversation('c1');
    expect(reloaded?.title).toBe('Renamed by object-form call + updater-form');
  });

  test('an updater-form call started right after ANOTHER updater-form call also observes the committed result, never a stale snapshot', async () => {
    await adapter.createConversation({
      id: 'c2',
      resourceId: 'agent-a',
      userId: 'u1',
      title: 'Initial',
      metadata: { count: 0 },
    });

    const readCount = (current: { metadata?: Record<string, unknown> }) =>
      (current.metadata?.count as number | undefined) ?? 0;

    const secondCallObservedCount: number[] = [];
    const firstWrite = adapter.updateConversation('c2', (current) => ({
      metadata: { ...current.metadata, count: readCount(current) + 1 },
    }));
    const secondWrite = adapter.updateConversation('c2', (current) => {
      secondCallObservedCount.push(readCount(current));
      return {
        metadata: {
          ...current.metadata,
          count: readCount(current) + 1,
        },
      };
    });

    await Promise.all([firstWrite, secondWrite]);

    expect(secondCallObservedCount).toEqual([1]);
    const reloaded = await adapter.getConversation('c2');
    expect(reloaded?.metadata).toMatchObject({ count: 2 });
  });

  test('an updater returning null skips the write entirely — no persisted change, updatedAt unchanged', async () => {
    const created = await adapter.createConversation({
      id: 'c3',
      resourceId: 'agent-a',
      userId: 'u1',
      title: 'Skip Me',
      metadata: { existing: 'value' },
    });

    const result = await adapter.updateConversation('c3', () => null);

    expect(result).toEqual(created);
    expect(result.updatedAt).toBe(created.updatedAt);

    const reloaded = await adapter.getConversation('c3');
    expect(reloaded).toEqual(created);
  });

  test('the object form (a static partial) still behaves exactly as before — full backward compatibility', async () => {
    await adapter.createConversation({
      id: 'c4',
      resourceId: 'agent-a',
      userId: 'u1',
      title: 'Original',
      metadata: { keep: 'this' },
    });

    const updated = await adapter.updateConversation('c4', {
      title: 'New Title',
    });

    expect(updated.title).toBe('New Title');
    // The object form never merges caller-supplied metadata automatically —
    // callers (e.g. the PATCH route's `sanitizePublicConversationUpdate`)
    // are responsible for merging before calling this, same as before.
    expect(updated.metadata).toEqual({ keep: 'this' });
  });

  test('throws when the conversation does not exist, for both the object and updater forms', async () => {
    await expect(
      adapter.updateConversation('missing', { title: 'x' }),
    ).rejects.toThrow('Conversation missing not found');
    await expect(
      adapter.updateConversation('missing', () => ({ title: 'x' })),
    ).rejects.toThrow('Conversation missing not found');
  });

  test('applies enrichment usage to the supplied enriched message when a newer turn is already stored', async () => {
    const applyEnrichmentUsage = vi.fn();
    adapter = new FileMemoryAdapter({
      projectHomeDir,
      usageAggregator: { applyEnrichmentUsage },
    });
    await adapter.createConversation({
      id: 'c5',
      resourceId: 'agent-a',
      userId: 'u1',
      title: 'Usage',
      metadata: {},
    });
    const enrichedTurnA = {
      id: 'turn-a',
      role: 'assistant' as const,
      parts: [{ type: 'text', text: 'A' }],
      metadata: { model: 'new-model', usage: { totalTokens: 12 } },
    } as UIMessage;
    await adapter.addMessage(enrichedTurnA, 'u1', 'c5', {
      suppressUsageAggregation: true,
    });
    await adapter.addMessage(
      {
        id: 'turn-b',
        role: 'assistant',
        parts: [{ type: 'text', text: 'B' }],
      },
      'u1',
      'c5',
      { suppressUsageAggregation: true },
    );

    await adapter.applyEnrichmentUsage('u1', 'c5', enrichedTurnA, 'old-model');

    expect(applyEnrichmentUsage).toHaveBeenCalledWith(
      enrichedTurnA,
      'agent-a',
      'c5',
      'old-model',
    );
  });
});
