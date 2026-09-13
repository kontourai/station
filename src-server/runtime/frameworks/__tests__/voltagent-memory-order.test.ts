import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Memory } from '@voltagent/core';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, test } from 'vitest';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';

test('a fast native reply cannot overtake durable input persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'station-native-memory-order-'));
  const storage = new FileMemoryAdapter({ projectHomeDir: root });
  let release!: () => void;
  let reached!: () => void;
  let saved!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstRead = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const inputSaved = new Promise<void>((resolve) => {
    saved = resolve;
  });
  let reads = 0;
  const isolatedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'getConversation')
        return async (
          ...args: Parameters<FileMemoryAdapter['getConversation']>
        ) => {
          if (++reads === 1) {
            reached();
            await held;
          }
          return target.getConversation(...args);
        };
      if (property === 'addMessage')
        return async (...args: Parameters<FileMemoryAdapter['addMessage']>) => {
          await target.addMessage(...args);
          if (args[0].role === 'user') saved();
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'A fast answer.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const agent = new Agent({
    id: 'memory-order',
    name: 'Memory order',
    instructions: 'Answer briefly.',
    model,
    memory: new Memory({ storage: isolatedStorage }),
  });
  const run = agent.generateText('Remember the first question.', {
    userId: 'owner',
    conversationId: 'conversation',
  });
  try {
    await firstRead;
    try {
      expect(model.doGenerateCalls).toHaveLength(0);
    } finally {
      release();
      await run;
      await inputSaved;
    }
    const persisted = await storage.getMessages('owner', 'conversation');
    expect(persisted.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});
