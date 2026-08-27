import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { describe, expect, test } from 'vitest';
import { foldUsageReceipts } from '../usage-rollup.js';

const window = { from: '2026-08-01', to: '2026-08-30' };
const receipt = (overrides: Partial<UsageReceipt> = {}): UsageReceipt => ({
  id: 'r1',
  stationId: 'local',
  provider: 'claude',
  occurredAt: '2026-08-10T00:00:00.000Z',
  observedAt: '2026-08-10T00:00:00.000Z',
  inputTokens: 10,
  outputTokens: 2,
  pricing: { status: 'unpriced' },
  ...overrides,
});

describe('foldUsageReceipts (station#4135)', () => {
  test('deduplicates replay and replaces a cumulative correction by observed time', () => {
    const result = foldUsageReceipts({
      ...window,
      receipts: [
        receipt(),
        receipt(),
        receipt({ inputTokens: 25, observedAt: '2026-08-11T00:00:00.000Z' }),
        receipt({ inputTokens: 10, observedAt: '2026-08-10T00:00:00.000Z' }),
      ],
      coverage: [],
    });
    expect(result.rows[0]?.inputTokens).toBe(25);
    expect(result.rows[0]?.receiptCount).toBe(1);
  });

  test('excludes unknown-time legacy receipts from ordinary observation windows', () => {
    const result = foldUsageReceipts({
      ...window,
      receipts: [
        receipt({
          id: 'late',
          occurredAt: undefined,
          observedAt: undefined,
          inputTokens: undefined,
          outputTokens: Number.NaN,
        }),
        receipt({ id: 'skew', occurredAt: '2026-07-30T23:59:00.000Z' }),
      ],
      coverage: [],
    });
    expect(result.receipts.map((item) => item.id)).toEqual(['skew']);
    expect(result.rows[0]?.inputTokens).toBe(10);
  });

  test('keeps model switches separate and refuses mixed currency/snapshot sums', () => {
    const result = foldUsageReceipts({
      ...window,
      receipts: [
        receipt({
          id: 'a',
          model: 'one',
          reportedCost: { amount: 1, currency: 'USD' },
          estimatedCost: {
            amount: 1,
            currency: 'USD',
            pricingSnapshotId: 'p1',
            pricingSnapshotObservedAt: '2026-08-01T00:00:00.000Z',
          },
        }),
        receipt({
          id: 'b',
          model: 'two',
          reportedCost: { amount: 1, currency: 'EUR' },
          estimatedCost: {
            amount: 1,
            currency: 'USD',
            pricingSnapshotId: 'p2',
            pricingSnapshotObservedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      ],
      coverage: [],
      groupBy: 'provider',
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.reportedCost).toBeUndefined();
    expect(result.rows[0]?.estimatedCost).toBeUndefined();
    expect(result.rows[0]?.reportedCostBuckets).toEqual([
      { amount: 1, currency: 'USD' },
      { amount: 1, currency: 'EUR' },
    ]);
    expect(result.rows[0]?.estimatedCostBuckets).toHaveLength(2);
  });

  test('keeps a partially priced receipt visible without converting it to zero', () => {
    const result = foldUsageReceipts({
      ...window,
      receipts: [
        receipt({ pricing: { status: 'partial', pricingSnapshotId: 'p' } }),
      ],
      coverage: [],
    });
    expect(result.rows[0]).toMatchObject({ pricingStatus: 'partial' });
    expect(result.rows[0]?.estimatedCost).toBeUndefined();
  });

  test('keeps a source page in observation/id order without applying a second offset', () => {
    const result = foldUsageReceipts({
      ...window,
      receipts: [
        receipt({ id: 'a' }),
        receipt({ id: 'b' }),
        receipt({ id: 'c' }),
      ],
      coverage: [],
      pageSize: 2,
    });
    expect(result.receipts.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.nextCursor).toBeUndefined();
  });

  test('keeps full-window totals independent of the receipt drilldown page', () => {
    const all = [
      receipt({ id: 'first', inputTokens: 10 }),
      receipt({
        id: 'second',
        inputTokens: 20,
        observedAt: '2026-08-11T00:00:00.000Z',
      }),
    ];
    const first = foldUsageReceipts({
      ...window,
      receipts: [all[0]!],
      aggregateReceipts: all,
      coverage: [],
    });
    const second = foldUsageReceipts({
      ...window,
      receipts: [all[1]!],
      aggregateReceipts: all,
      coverage: [],
    });
    expect(first.rows[0]?.inputTokens).toBe(30);
    expect(second.rows[0]?.inputTokens).toBe(30);
    expect(second.receipts.map((item) => item.id)).toEqual(['second']);
  });

  test('uses Station observation time for day grouping under provider clock skew', () => {
    const result = foldUsageReceipts({
      ...window,
      groupBy: 'day',
      receipts: [
        receipt({
          occurredAt: '2026-07-31T23:59:59.000Z',
          observedAt: '2026-08-01T00:00:01.000Z',
        }),
      ],
      coverage: [],
    });
    expect(result.rows[0]?.day).toBe('2026-08-01');
  });
});
