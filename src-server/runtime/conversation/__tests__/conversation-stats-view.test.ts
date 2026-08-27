import { describe, expect, test } from 'vitest';
import {
  buildConversationStatsView,
  buildEmptyConversationStatsView,
  resolveConversationUserMessageTokens,
} from '../conversation-stats-view.js';

describe('conversation-stats-view', () => {
  test('buildEmptyConversationStatsView returns the shared zero-state shape', () => {
    expect(
      buildEmptyConversationStatsView({
        modelId: 'm',
        systemPromptTokens: 10,
        mcpServerTokens: 5,
        notFound: true,
      }),
    ).toEqual(
      expect.objectContaining({
        inputTokens: 0,
        totalTokens: 0,
        contextTokens: 15,
        modelId: 'm',
        notFound: true,
      }),
    );
  });

  test('resolveConversationUserMessageTokens counts only user text content', () => {
    expect(
      resolveConversationUserMessageTokens([
        { role: 'user', parts: [{ type: 'text', text: 'abcd' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'ignore me' }] },
        { role: 'user', parts: [{ type: 'text', text: 'abcdefgh' }] },
      ]),
    ).toBe(3);
  });

  test('buildConversationStatsView merges stored stats and derived fields', () => {
    expect(
      buildConversationStatsView({
        stats: {
          inputTokens: 12,
          outputTokens: 7,
          totalTokens: 19,
          turns: 2,
          toolCalls: 1,
          estimatedCost: 0.2,
        },
        conversationId: 'c1',
        modelId: 'm1',
        systemPromptTokens: 4,
        mcpServerTokens: 2,
        userMessageTokens: 6,
      }),
    ).toEqual(
      expect.objectContaining({
        conversationId: 'c1',
        modelId: 'm1',
        userMessageTokens: 6,
        assistantMessageTokens: 7,
        contextFilesTokens: 0,
      }),
    );
  });

  test('buildConversationStatsView threads contextWindowTokens through to the percentage (station#1299 item 3a)', () => {
    const view = buildConversationStatsView({
      stats: {
        inputTokens: 262_500,
        outputTokens: 0,
        totalTokens: 262_500,
        contextTokens: 262_500,
        turns: 1,
        toolCalls: 0,
        estimatedCost: 0,
      },
      conversationId: 'c1',
      modelId: 'claude-opus-4-1',
      systemPromptTokens: 0,
      mcpServerTokens: 0,
      contextWindowTokens: 750_000,
    });
    expect(view.contextWindowPercentage).toBe(35);
  });

  test('buildEmptyConversationStatsView threads contextWindowTokens through to the percentage', () => {
    const view = buildEmptyConversationStatsView({
      modelId: 'claude-opus-4-1',
      systemPromptTokens: 50_000,
      mcpServerTokens: 50_000,
      contextWindowTokens: 800_000,
    });
    expect(view.contextWindowPercentage).toBe(12.5);
  });
});
