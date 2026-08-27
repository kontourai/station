import { describe, expect, test, vi } from 'vitest';
import { recordToolExecutionUsage } from '../tool-execution-usage.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('tool-execution-usage', () => {
  test('returns early when there is no conversation id', async () => {
    const logger = createLogger();
    await recordToolExecutionUsage({
      context: { context: new Map() },
      output: { usage: {} },
      agent: { getMemory: vi.fn() },
      appConfig: { defaultModel: 'model-a' } as any,
      configLoader: {} as any,
      modelCatalog: undefined,
      agentFixedTokens: new Map(),
      memoryAdapters: new Map(),
      logger,
    });

    expect(logger.error).not.toHaveBeenCalled();
  });

  test('logs aborted usage and skips stats updates when usage is missing', async () => {
    const getConversation = vi.fn().mockResolvedValue({
      resourceId: 'default',
      metadata: {},
    });
    const getMessages = vi.fn().mockResolvedValue([]);
    const updateConversation = vi.fn();
    const logger = createLogger();

    await recordToolExecutionUsage({
      context: {
        conversationId: 'conv-1',
        userId: 'user-1',
        context: new Map([['toolCallCount', 2]]),
      },
      output: {},
      agent: {
        getMemory: () => ({ getConversation, getMessages, updateConversation }),
      },
      appConfig: { defaultModel: 'model-a' } as any,
      configLoader: {} as any,
      modelCatalog: undefined,
      agentFixedTokens: new Map(),
      memoryAdapters: new Map(),
      logger,
    });

    expect(getConversation).toHaveBeenCalledWith('conv-1');
    expect(logger.info).toHaveBeenCalledWith(
      '[Usage Stats]',
      expect.objectContaining({ aborted: true, toolCallCount: 2 }),
    );
    expect(updateConversation).not.toHaveBeenCalled();
  });
});
