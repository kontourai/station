import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type {
  UsageCoverage,
  UsageReceipt,
} from '@kontourai/station-contracts/usage-rollup';
import { describe, expect, test, vi } from 'vitest';
import { LocalUsageReceiptSource } from '../local-usage-receipt-source.js';

const request = { from: '2026-08-01', to: '2026-08-07', pageSize: 25 };
const authority = sessionReadAuthorityFromRequest(
  'usage-reader',
  undefined,
  undefined,
);
const receipt: UsageReceipt = {
  id: 'receipt-1',
  stationId: 'local',
  provider: 'claude',
  observedAt: '2026-08-06T12:00:00.000Z',
  pricing: { status: 'unpriced' },
};

function sourceFor(
  page:
    | {
        receipts: UsageReceipt[];
        coverage?: UsageCoverage;
        nextCursor?: string;
      }
    | undefined,
) {
  const readUsageReceipts = vi.fn((_station, _authority, input) =>
    input.pageSize === 500 ? page : page,
  );
  return {
    source: new LocalUsageReceiptSource('local', { readUsageReceipts } as any),
    readUsageReceipts,
  };
}

describe('LocalUsageReceiptSource (station#4135)', () => {
  test.each([
    ['complete', { stationId: 'local', state: 'complete', window: request }],
    [
      'partial',
      {
        stationId: 'local',
        state: 'partial',
        reason: 'terminal turns missing usage reports',
        window: request,
      },
    ],
  ] as const)(
    'preserves authoritative %s source coverage',
    async (_, coverage) => {
      const { source } = sourceFor({ receipts: [receipt], coverage });
      const result = await source.read(
        request,
        authority,
        new AbortController().signal,
      );
      expect(result.coverage).toEqual(coverage);
    },
  );

  test('marks an empty projection unknown instead of calling it a measured zero', async () => {
    const { source } = sourceFor({ receipts: [] });
    const result = await source.read(
      request,
      authority,
      new AbortController().signal,
    );
    expect(result.coverage).toMatchObject({
      state: 'unknown',
      reason: 'no indexed usage observations for this window',
    });
  });

  test('keeps unavailable canonical usage distinct from an empty projection', async () => {
    const { source } = sourceFor(undefined);
    const result = await source.read(
      request,
      authority,
      new AbortController().signal,
    );
    expect(result.coverage).toMatchObject({
      state: 'unknown',
      reason: 'canonical session usage unavailable',
    });
  });
});
