import { describe, expect, test, vi } from 'vitest';
import { BedrockUsagePricingSnapshotCapture } from '../usage-pricing-snapshot-capture.js';

describe('BedrockUsagePricingSnapshotCapture (station#4135)', () => {
  test('captures an exact immutable catalog row at ingestion and changes only with rates', async () => {
    const getModelPricing = vi
      .fn()
      .mockResolvedValueOnce([
        {
          modelId: 'model-a',
          region: 'us-west-2',
          feature: 'On-demand Inference',
          inputTokenPrice: 0.002,
          outputTokenPrice: 0.004,
        },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'model-a',
          region: 'us-west-2',
          feature: 'On-demand Inference',
          inputTokenPrice: 0.003,
          outputTokenPrice: 0.004,
        },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'partial-model',
          region: 'us-west-2',
          feature: 'On-demand Inference',
          inputTokenPrice: 0.003,
        },
      ])
      .mockResolvedValueOnce([]);
    const capture = new BedrockUsagePricingSnapshotCapture(
      { getModelPricing },
      'us-west-2',
    );
    const first = await capture.capture({
      provider: 'bedrock',
      model: 'model-a',
      observedAt: '2026-08-05T00:00:00.000Z',
    });
    const changed = await capture.capture({
      provider: 'bedrock',
      model: 'model-a',
      observedAt: '2026-08-06T00:00:00.000Z',
    });
    expect(first).toMatchObject({
      currency: 'USD',
      source: 'station.bedrock-model-catalog:us-west-2',
      inputPerMillion: 2,
      outputPerMillion: 4,
    });
    expect(changed).toMatchObject({ inputPerMillion: 3 });
    expect(changed?.id).not.toBe(first?.id);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(
      capture.capture({
        provider: 'bedrock',
        model: 'partial-model',
        observedAt: '2026-08-06T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ inputPerMillion: 3 });
    await expect(
      capture.capture({
        provider: 'bedrock',
        model: 'not-an-exact-model',
        observedAt: '2026-08-06T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
  });
});
