import type { UsageExportPage } from '@kontourai/station-contracts/usage-export';

export function usageExportFixture(): UsageExportPage {
  return {
    schemaVersion: 1,
    stationId: 'station-a',
    streamEpoch: 'epoch-a',
    highWater: 9,
    scope: 'individual',
    window: {
      from: '2026-10-01',
      to: '2026-10-11',
      clock: 'station-observed-utc',
    },
    observations: [
      {
        globalSequence: 3,
        receipts: [
          {
            id: 'usage:thread-a:cost',
            sourceEventId: 'event-3',
            sourceSequence: 1,
            stationId: 'station-a',
            provider: 'codex',
            threadId: 'thread-a',
            occurredAt: '2026-09-30T23:59:00.000Z',
            observedAt: '2026-10-01T00:01:00.000Z',
            reportedCost: { amount: 0.12, currency: 'EUR' },
            pricing: { status: 'unpriced' },
          },
        ],
      },
      {
        globalSequence: 7,
        receipts: [
          {
            id: 'usage:thread-a:cost',
            sourceEventId: 'event-7',
            sourceSequence: 2,
            stationId: 'station-a',
            provider: 'codex',
            threadId: 'thread-a',
            observedAt: '2026-10-02T00:01:00.000Z',
            reportedCost: { amount: 0.15, currency: 'EUR' },
            pricing: { status: 'unpriced' },
          },
          {
            id: 'usage:event-7:tokens',
            stationId: 'station-a',
            provider: 'codex',
            model: 'model-a',
            observedAt: '2026-10-02T00:01:00.000Z',
            inputTokens: 50,
            outputTokens: 0,
            estimatedCost: {
              amount: 0.004,
              currency: 'USD',
              pricingSnapshotId: 'catalog-1',
              pricingSnapshotObservedAt: '2026-09-01T00:00:00.000Z',
              pricingSnapshotSource: 'catalog',
            },
            pricing: {
              status: 'partial',
              pricingSnapshotId: 'catalog-1',
              pricingSnapshotCapturedAt: '2026-09-01T00:00:00.000Z',
              pricingSnapshotSource: 'catalog',
              provider: 'codex',
              model: 'model-a',
              currency: 'USD',
            },
          },
        ],
      },
    ],
    nextCursor: 'opaque_next',
    coverage: {
      state: 'unknown',
      reason:
        'retained-observations-do-not-prove-provider-or-deletion-coverage',
    },
  };
}
