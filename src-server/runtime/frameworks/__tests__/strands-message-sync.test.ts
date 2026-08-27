import { describe, expect, test, vi } from 'vitest';
import {
  mapStrandsContentBlocksToParts,
  syncStrandsMessagesToMemory,
} from '../strands-message-sync.js';

describe('mapStrandsContentBlocksToParts', () => {
  test('maps strands content blocks to persisted UI parts', () => {
    expect(
      mapStrandsContentBlocksToParts([
        { text: 'hello' },
        { type: 'reasoningBlock', reasoningText: 'think' },
        {
          type: 'toolUseBlock',
          toolUseId: 'tool-1',
          name: 'read_file',
          input: { path: 'a' },
        },
        { type: 'toolResultBlock', toolUseId: 'tool-1', content: { ok: true } },
      ]),
    ).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'think' },
      {
        type: 'tool-invocation',
        toolInvocation: {
          toolCallId: 'tool-1',
          toolName: 'read_file',
          args: { path: 'a' },
          state: 'result',
        },
      },
      { type: 'tool-result', toolCallId: 'tool-1', result: { ok: true } },
    ]);
  });

  test('projects failed tool blocks without persisting remote text', () => {
    const canary = 'remote-strands-memory-canary';
    const parts = mapStrandsContentBlocksToParts([
      {
        type: 'toolResultBlock',
        toolUseId: 'tool-1',
        status: 'error',
        content: [{ text: canary }],
      },
    ]);
    expect(JSON.stringify(parts)).not.toContain(canary);
    expect(parts).toMatchObject([{ result: { isError: true } }]);
  });

  test('strips a native declaration handle recursively before transcript persistence only for its exact tool call', () => {
    const handle = 'opaque-declaration-handle';
    const parts = mapStrandsContentBlocksToParts([
      {
        type: 'toolUseBlock',
        toolUseId: 'declared-call',
        name: 'declare_output',
      },
      {
        type: 'toolResultBlock',
        toolUseId: 'declared-call',
        content: [{ json: { nested: { declarationHandle: handle } } }],
      },
      {
        type: 'toolResultBlock',
        toolUseId: 'ordinary-call',
        content: { declarationHandle: handle },
      },
    ]);
    expect(JSON.stringify(parts[1])).not.toContain(handle);
    expect(parts[2]).toMatchObject({ result: { declarationHandle: handle } });
  });
});

describe('syncStrandsMessagesToMemory', () => {
  test('persists only new strands messages for the active conversation', async () => {
    const memoryAdapter = {
      getMessages: vi.fn().mockResolvedValue([{ id: 'existing' }]),
      addMessage: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { info: vi.fn(), error: vi.fn() };

    await syncStrandsMessagesToMemory({
      agentMessages: [
        { role: 'user', content: [{ text: 'old' }] },
        { role: 'assistant', content: [{ text: 'new' }] },
      ],
      invocation: {
        agentSlug: 'agent',
        conversationId: 'conv-1',
        userId: 'user-1',
      },
      logger,
      memoryAdapter: memoryAdapter as any,
      resolvedModel: 'anthropic.test',
    });

    expect(memoryAdapter.getMessages).toHaveBeenCalledWith('user-1', 'conv-1');
    expect(memoryAdapter.addMessage).toHaveBeenCalledTimes(1);
    expect(memoryAdapter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        parts: [{ type: 'text', text: 'new' }],
      }),
      'user-1',
      'conv-1',
      { model: 'anthropic.test' },
    );
  });

  test('skips persistence when no conversation id is present', async () => {
    const memoryAdapter = {
      getMessages: vi.fn(),
      addMessage: vi.fn(),
    };
    const logger = { info: vi.fn(), error: vi.fn() };

    await syncStrandsMessagesToMemory({
      agentMessages: [{ role: 'assistant', content: [{ text: 'new' }] }],
      invocation: { agentSlug: 'agent' },
      logger,
      memoryAdapter: memoryAdapter as any,
      resolvedModel: 'anthropic.test',
    });

    expect(memoryAdapter.getMessages).not.toHaveBeenCalled();
    expect(memoryAdapter.addMessage).not.toHaveBeenCalled();
  });
});
