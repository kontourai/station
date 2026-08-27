import { describe, expect, test } from 'vitest';
import {
  CatalogUsagePricingSnapshotReader,
  stampUsageReceiptPrice,
} from '../usage-pricing-snapshot-reader.js';

const reader = new CatalogUsagePricingSnapshotReader([
  {
    id: 'catalog-a',
    capturedAt: '2026-08-01T00:00:00.000Z',
    currency: 'USD',
    provider: 'bedrock',
    model: 'model-a',
    inputPerMillion: 2,
    outputPerMillion: 4,
  },
]);

describe('UsagePricingSnapshotReader (station#4135)', () => {
  test('uses only the exact captured provider/model snapshot and leaves unmatched receipts unpriced', () => {
    const receipt = stampUsageReceiptPrice(
      {
        id: 'one',
        stationId: 'local',
        provider: 'bedrock',
        model: 'model-a',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      reader,
    );
    expect(receipt).toMatchObject({
      estimatedCost: {
        amount: 6,
        currency: 'USD',
        pricingSnapshotId: 'catalog-a',
      },
      pricing: {
        status: 'priced',
        pricingSnapshotCapturedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(
      stampUsageReceiptPrice(
        { id: 'two', stationId: 'local', provider: 'bedrock', model: 'other' },
        reader,
      ).pricing.status,
    ).toBe('unpriced');
  });

  test('does not invent a complete estimate when the captured snapshot is partial', () => {
    const partial = new CatalogUsagePricingSnapshotReader([
      {
        id: 'partial',
        capturedAt: '2026-08-02T00:00:00.000Z',
        currency: 'EUR',
        provider: 'bedrock',
        model: 'model-b',
        inputPerMillion: 1,
      },
    ]);
    const receipt = stampUsageReceiptPrice(
      {
        id: 'three',
        stationId: 'local',
        provider: 'bedrock',
        model: 'model-b',
        inputTokens: 2,
        outputTokens: 3,
      },
      partial,
    );
    expect(receipt.pricing.status).toBe('partial');
    expect(receipt.estimatedCost).toBeUndefined();
  });

  test('prices disjoint cache components only with exact component rates', () => {
    const cached = new CatalogUsagePricingSnapshotReader([
      {
        id: 'claude-cache',
        capturedAt: '2026-08-03T00:00:00.000Z',
        source: 'station.catalog',
        currency: 'USD',
        provider: 'claude',
        model: 'claude-model',
        inputPerMillion: 2,
        outputPerMillion: 4,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 2.5,
      },
    ]);
    expect(
      stampUsageReceiptPrice(
        {
          id: 'cache-priced',
          stationId: 'local',
          provider: 'claude',
          model: 'claude-model',
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
        },
        cached,
      ),
    ).toMatchObject({
      pricing: { status: 'priced', pricingSnapshotSource: 'station.catalog' },
      estimatedCost: { amount: 8.7, currency: 'USD' },
    });
    expect(
      stampUsageReceiptPrice(
        {
          id: 'cache-rate-missing',
          stationId: 'local',
          provider: 'claude',
          model: 'claude-model',
          cacheReadTokens: 1,
        },
        new CatalogUsagePricingSnapshotReader([
          {
            id: 'no-cache-rate',
            capturedAt: '2026-08-03T00:00:00.000Z',
            currency: 'USD',
            provider: 'claude',
            model: 'claude-model',
            inputPerMillion: 2,
            outputPerMillion: 4,
          },
        ]),
      ).pricing.status,
    ).toBe('partial');
  });

  test('does not price cache components from an unverified provider', () => {
    const receipt = stampUsageReceiptPrice(
      {
        id: 'codex-cache',
        stationId: 'local',
        provider: 'codex',
        model: 'codex-model',
        inputTokens: 1,
        cacheReadTokens: 1,
      },
      new CatalogUsagePricingSnapshotReader([
        {
          id: 'codex-catalog',
          capturedAt: '2026-08-04T00:00:00.000Z',
          currency: 'EUR',
          provider: 'codex',
          model: 'codex-model',
          inputPerMillion: 2,
          outputPerMillion: 4,
          cacheReadPerMillion: 1,
        },
      ]),
    );
    expect(receipt).toMatchObject({
      pricing: { status: 'partial', currency: 'EUR' },
    });
    expect(receipt.estimatedCost).toBeUndefined();
  });
});
