import { describe, expect, it, vi } from 'vitest';
import {
  buildConversationStatsUpdate,
  calculateContextWindowPercentage,
  calculateUsageCost,
  createEmptyConversationStats,
  getMessageTextContent,
} from '../usage-stats.js';

describe('usage-stats', () => {
  it('does not manufacture token figures for empty conversation stats', () => {
    expect(createEmptyConversationStats()).toEqual({
      contextTokens: 0,
      turns: 0,
      toolCalls: 0,
      estimatedCost: null,
    });
  });

  it('builds updated conversation stats from prior state', () => {
    const existingStats = {
      ...createEmptyConversationStats(),
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      contextTokens: 170,
      turns: 2,
      toolCalls: 1,
      estimatedCost: 1.5,
      tokenBreakdown: {
        systemPromptTokens: 20,
        mcpServerTokens: 10,
        userMessageTokens: 40,
        assistantMessageTokens: 50,
      },
    };

    const { updatedStats, modelStats } = buildConversationStatsUpdate({
      existingStats,
      existingModelStats: {
        'anthropic.claude': existingStats,
      },
      usage: {
        promptTokens: 25,
        completionTokens: 15,
      },
      toolCallCount: 2,
      modelId: 'anthropic.claude',
      latestUserMessageText: 'hello there',
      fixedTokens: {
        systemPromptTokens: 20,
        mcpServerTokens: 10,
      },
      cost: 0.2,
    });

    expect(updatedStats).toEqual({
      inputTokens: 125,
      outputTokens: 65,
      totalTokens: 190,
      contextTokens: 138,
      turns: 3,
      toolCalls: 3,
      estimatedCost: 1.7,
      tokenBreakdown: {
        systemPromptTokens: 20,
        mcpServerTokens: 10,
        userMessageTokens: 43,
        assistantMessageTokens: 65,
      },
    });
    expect(modelStats['anthropic.claude']).toEqual({
      inputTokens: 125,
      outputTokens: 65,
      totalTokens: 190,
      contextTokens: 138,
      turns: 3,
      toolCalls: 3,
      estimatedCost: 1.7,
      tokenBreakdown: {
        systemPromptTokens: 20,
        mcpServerTokens: 10,
        userMessageTokens: 43,
        assistantMessageTokens: 65,
      },
    });
  });

  it.each([
    { usage: { inputTokens: -1 }, toolCallCount: 0, cost: 0 },
    { usage: { outputTokens: Number.NaN }, toolCallCount: 0, cost: 0 },
    {
      usage: { totalTokens: Number.POSITIVE_INFINITY },
      toolCallCount: 0,
      cost: 0,
    },
    { usage: {}, toolCallCount: -1, cost: 0 },
    { usage: {}, toolCallCount: 0, cost: -0.01 },
  ])('rejects malformed canonical usage before arithmetic: $usage', (input) => {
    expect(() =>
      buildConversationStatsUpdate({
        existingStats: createEmptyConversationStats(),
        usage: input.usage,
        toolCallCount: input.toolCallCount,
        modelId: 'test-model',
        cost: input.cost,
      }),
    ).toThrow('Conversation usage update was invalid');
  });

  it('preserves null cost as explicit unknown', () => {
    const { updatedStats } = buildConversationStatsUpdate({
      existingStats: createEmptyConversationStats(),
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      toolCallCount: 0,
      modelId: 'test-model',
      cost: null,
    });
    expect(updatedStats.estimatedCost).toBeNull();
    expect(updatedStats.totalTokens).toBe(3);
  });

  it('extracts text content from supported message shapes', () => {
    expect(
      getMessageTextContent({
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', text: 'ignored' },
          { type: 'text', text: ' world' },
        ],
      }),
    ).toBe('hello world');
    expect(
      getMessageTextContent({
        content: [{ text: 'alpha' }, { text: 'beta' }],
      }),
    ).toBe('alphabeta');
    expect(getMessageTextContent({ content: 'plain text' })).toBe('plain text');
  });

  it('returns an explicit unknown percentage without a resolved context window', () => {
    expect(calculateContextWindowPercentage(50_000)).toBeUndefined();
  });

  it('uses the resolved model context-window size (station#1299 item 3)', () => {
    expect(calculateContextWindowPercentage(100_000, 1_000_000)).toBe(10);
  });

  it('returns an explicit unknown percentage for an invalid context window', () => {
    expect(calculateContextWindowPercentage(50_000, 0)).toBeUndefined();
    expect(calculateContextWindowPercentage(50_000, -5)).toBeUndefined();
    expect(
      calculateContextWindowPercentage(50_000, Number.NaN),
    ).toBeUndefined();
  });

  it('returns unknown for malformed folded totals instead of negative, null, or false zero', () => {
    expect(calculateContextWindowPercentage(-1, 100)).toBeUndefined();
    expect(calculateContextWindowPercentage(Number.NaN, 100)).toBeUndefined();
    expect(
      calculateContextWindowPercentage(Number.POSITIVE_INFINITY, 100),
    ).toBeUndefined();
  });

  it('calculates usage cost from model pricing', async () => {
    const logger = { warn: vi.fn() };
    const modelCatalog = {
      getModelPricing: vi.fn().mockResolvedValue([
        {
          modelId: 'Claude 4 Sonnet',
          inputTokenPrice: 0.003,
          outputTokenPrice: 0.015,
        },
      ]),
    };

    const cost = await calculateUsageCost(
      'claude-4-sonnet',
      { promptTokens: 1000, completionTokens: 500 },
      modelCatalog as any,
      'bedrock',
      { region: 'us-west-2' } as any,
      logger,
    );

    expect(cost).toBeCloseTo(0.0105, 10);
    expect(modelCatalog.getModelPricing).toHaveBeenCalledWith('us-west-2');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves a non-Bedrock route unpriced even when a Bedrock row would match', async () => {
    // The Bedrock catalog is constructed unconditionally, so every provider's
    // turn used to reach Amazon's price list. This row matches 'claude-4-sonnet'
    // by the same slug containment the Bedrock tests above rely on -- so if the
    // route's provider is not consulted, this turn is priced from Amazon's rate
    // for a route Station never billed through Bedrock.
    const logger = { warn: vi.fn() };
    const modelCatalog = {
      getModelPricing: vi.fn().mockResolvedValue([
        {
          modelId: 'Claude 4 Sonnet',
          inputTokenPrice: 0.003,
          outputTokenPrice: 0.015,
        },
      ]),
    };

    const cost = await calculateUsageCost(
      'claude-4-sonnet',
      { promptTokens: 1000, completionTokens: 500 },
      modelCatalog as any,
      'anthropic',
      { region: 'us-west-2' } as any,
      logger,
    );

    expect(cost).toBeNull();
    expect(modelCatalog.getModelPricing).not.toHaveBeenCalled();
  });

  it('keeps cache-bearing usage unpriced when the catalog has no cache rates', async () => {
    // The priced input/output subset must not masquerade as the complete cost.
    const logger = { warn: vi.fn() };
    const modelCatalog = {
      getModelPricing: vi.fn().mockResolvedValue([
        {
          modelId: 'Claude 4 Sonnet',
          inputTokenPrice: 0.003,
          outputTokenPrice: 0.015,
        },
      ]),
    };

    await expect(
      calculateUsageCost(
        'claude-4-sonnet',
        {
          promptTokens: 1_000,
          completionTokens: 500,
          cacheReadTokens: 2_000,
        },
        modelCatalog as any,
        'bedrock',
        { region: 'us-west-2' } as any,
        logger,
      ),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Pricing incomplete for reported usage, cost unavailable',
      { modelId: 'claude-4-sonnet' },
    );
  });

  it('logs malformed producer usage separately from missing pricing', async () => {
    const logger = { warn: vi.fn() };
    const modelCatalog = {
      getModelPricing: vi.fn().mockResolvedValue([
        {
          modelId: 'Claude 4 Sonnet',
          inputTokenPrice: 0.003,
          outputTokenPrice: 0.015,
        },
      ]),
    };

    await expect(
      calculateUsageCost(
        'claude-4-sonnet',
        { promptTokens: Number.NaN, completionTokens: 500 },
        modelCatalog as any,
        'bedrock',
        { region: 'us-west-2' } as any,
        logger,
      ),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'Reported usage contains an invalid token figure, cost unavailable',
      { modelId: 'claude-4-sonnet' },
    );
  });
});
