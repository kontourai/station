import { describe, expect, test } from 'vitest';
import type { ModelPricing } from '../../providers/llm/bedrock-models.js';
import { estimateCost } from '../pricing.js';

const pricing: ModelPricing = {
  modelId: 'model-a',
  inputTokenPrice: 0.003,
  outputTokenPrice: 0.015,
  region: 'us-east-1',
  feature: 'On-demand Inference',
};

describe('estimateCost', () => {
  test('keeps missing pricing and missing usage distinguishable from free', () => {
    expect(
      estimateCost(undefined, { inputTokens: 1_000, outputTokens: 500 }),
    ).toBeUndefined();
    expect(estimateCost(pricing, {})).toBeUndefined();
  });

  test('prices a declared zero rate as a measured zero cost', () => {
    expect(
      estimateCost(
        { ...pricing, inputTokenPrice: 0, outputTokenPrice: 0 },
        { inputTokens: 1_000, outputTokens: 500 },
      ),
    ).toBe(0);
  });

  test('keeps the whole estimate absent until every reported component has a rate', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 250,
    };

    expect(estimateCost(pricing, usage)).toBeUndefined();
    expect(
      estimateCost(
        {
          ...pricing,
          cacheReadTokenPrice: 0.000_3,
          cacheWriteTokenPrice: 0.003_75,
        },
        usage,
      ),
    ).toBeCloseTo(0.012_037_5, 10);
  });
});
