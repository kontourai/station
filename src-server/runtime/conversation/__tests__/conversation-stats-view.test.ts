import { parseConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import { describe, expect, test } from 'vitest';
import {
  buildConversationStatsView,
  buildEmptyConversationStatsView,
  resolveConversationUserMessageTokens,
} from '../conversation-stats-view.js';
import { buildConversationStatsUpdate } from '../usage-stats.js';

describe('conversation-stats-view', () => {
  test.each([null, 0])(
    'keeps producer pricing %s honest through the shared wire validator',
    (cost) => {
      const { updatedStats, modelStats } = buildConversationStatsUpdate({
        usage: { promptTokens: 3, completionTokens: 2 },
        toolCallCount: 0,
        modelId: 'local-model',
        cost,
      });
      const view = buildConversationStatsView({
        stats: updatedStats,
        modelStats,
        modelId: 'local-model',
      });
      const parsed = parseConversationStatsResponse(
        JSON.parse(JSON.stringify(view)),
      );
      expect(parsed).toBeDefined();
      expect(parsed?.modelStats?.['local-model']).toMatchObject({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        turns: 1,
        toolCalls: 0,
      });
      if (cost === null)
        expect(parsed?.modelStats?.['local-model']).not.toHaveProperty(
          'estimatedCost',
        );
      else expect(parsed?.modelStats?.['local-model']?.estimatedCost).toBe(0);
      // Wire projection must not rewrite the persisted unknown-pricing marker.
      expect(modelStats['local-model']?.estimatedCost).toBe(cost);
    },
  );

  test('preserves unreported model token measurements instead of inventing zeros', () => {
    const { updatedStats, modelStats } = buildConversationStatsUpdate({
      usage: {},
      toolCallCount: 0,
      modelId: 'unreported',
      cost: null,
    });
    const parsed = parseConversationStatsResponse(
      buildConversationStatsView({
        stats: updatedStats,
        modelStats,
        modelId: 'unreported',
      }),
    );
    expect(parsed).toBeDefined();
    expect(parsed?.modelStats?.unreported).not.toHaveProperty('inputTokens');
    expect(parsed?.modelStats?.unreported).not.toHaveProperty('outputTokens');
    expect(parsed?.modelStats?.unreported).not.toHaveProperty('totalTokens');
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 'unknown'])(
    'keeps malformed per-model cost %s rejected',
    (estimatedCost) => {
      const view = buildConversationStatsView({
        stats: { turns: 1, toolCalls: 0 },
        modelId: 'bad',
        modelStats: { bad: { turns: 1, toolCalls: 0, estimatedCost } },
      });
      expect(parseConversationStatsResponse(view)).toBeUndefined();
    },
  );

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
