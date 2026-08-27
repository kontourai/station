import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addStoredMessage,
  addStoredMessages,
  readStoredMessages,
  removeLastStoredMessage,
} from '../memory-adapter-messages.js';
import { MemoryAdapterPaths } from '../memory-adapter-paths.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import('node:fs/promises').then(({ rm }) =>
        rm(dir, { recursive: true, force: true }),
      );
    }),
  );
});

async function createPaths() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-adapter-messages-'));
  tempDirs.push(dir);
  return new MemoryAdapterPaths(dir);
}

describe('memory-adapter message helpers', () => {
  test('adds assistant message metadata and cancellation notice', async () => {
    const paths = await createPaths();
    const touchConversation = vi.fn();
    const usageAggregator = { incrementalUpdate: vi.fn() };
    const controller = new AbortController();
    controller.abort();

    await addStoredMessage({
      paths,
      resolveResourceId: async () => 'agent-a',
      touchConversation,
      usageAggregator,
      message: {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Result' }],
      } as UIMessage,
      userId: 'user-1',
      conversationId: 'conv-1',
      context: {
        abortController: controller,
        model: 'test-model',
        traceId: 'trace-1',
      },
    });

    const stored = await readFile(
      paths.getMessagesPath('agent-a', 'conv-1'),
      'utf-8',
    );
    const parsed = JSON.parse(stored.trim()) as UIMessage & {
      metadata?: Record<string, unknown>;
    };

    expect(parsed.metadata).toMatchObject({
      model: 'test-model',
      traceId: 'trace-1',
    });
    expect(parsed.parts.at(-1)).toEqual({
      type: 'text',
      text: '\n\n---\n\n_⚠️ Response cancelled by user_',
    });
    expect(touchConversation).toHaveBeenCalledWith('conv-1');
    expect(usageAggregator.incrementalUpdate).toHaveBeenCalledTimes(1);
  });

  test('does not increment usage again when enriching an already persisted assistant message', async () => {
    const paths = await createPaths();
    const usageAggregator = { incrementalUpdate: vi.fn() };
    const input = {
      paths,
      resolveResourceId: async () => 'agent-a',
      touchConversation: vi.fn(),
      usageAggregator,
      message: {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Result' }],
      } as UIMessage,
      userId: 'user-1',
      conversationId: 'conv-1',
    };

    await addStoredMessage(input);
    await addStoredMessage({
      ...input,
      context: { suppressUsageAggregation: true, usage: { inputTokens: 1 } },
    });

    expect(usageAggregator.incrementalUpdate).toHaveBeenCalledTimes(1);
  });

  test('reads limited messages and removes the last line', async () => {
    const paths = await createPaths();
    const touchConversation = vi.fn();

    await addStoredMessages({
      paths,
      resolveResourceId: async () => 'agent-b',
      touchConversation,
      userId: 'user-2',
      conversationId: 'conv-2',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'first' }],
        } as UIMessage,
        {
          id: 'msg-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'second' }],
        } as UIMessage,
      ],
    });

    expect(
      await readStoredMessages({
        paths,
        resolveResourceId: async () => 'agent-b',
        findConversationLocation: async () => null,
        userId: 'user-2',
        conversationId: 'conv-2',
        options: { limit: 1 },
      }),
    ).toEqual([
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'second' }],
      },
    ]);

    await removeLastStoredMessage({
      paths,
      resolveResourceId: async () => 'agent-b',
      userId: 'user-2',
      conversationId: 'conv-2',
    });

    expect(
      await readStoredMessages({
        paths,
        resolveResourceId: async () => 'agent-b',
        findConversationLocation: async () => null,
        userId: 'user-2',
        conversationId: 'conv-2',
      }),
    ).toEqual([
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'first' }],
      },
    ]);
  });
});
