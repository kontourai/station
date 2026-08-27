/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const result = vi.hoisted(() => ({
  data: {
    coverage: [
      {
        stationId: 'local',
        state: 'partial',
        observedThrough: '2026-08-25T12:00:00.000Z',
        observedTurnCount: 3,
        usageReportedTurnCount: 2,
        droppedReceiptCount: 100,
        droppedReceiptWindow: { from: '2026-08-19', to: '2026-08-25' },
        window: { from: '2026-08-19', to: '2026-08-25' },
        providers: [
          {
            provider: 'codex',
            state: 'offline',
            freshness: 'stale',
            observedTurnCount: 2,
            usageReportedTurnCount: 0,
            window: { from: '2026-08-19', to: '2026-08-25' },
          },
        ],
      },
    ],
    rows: [
      {
        key: 'provider:codex',
        stationId: 'local',
        provider: 'codex',
        pricingStatus: 'partial',
        receiptCount: 2,
        reportedCostBuckets: [
          { amount: 1, currency: 'USD' },
          { amount: 2, currency: 'EUR' },
        ],
      },
      {
        key: 'provider:bedrock',
        stationId: 'local',
        provider: 'bedrock',
        pricingStatus: 'priced',
        receiptCount: 1,
        estimatedCost: {
          amount: 1,
          currency: 'USD',
          pricingSnapshotId: 'catalog-usd',
          pricingSnapshotObservedAt: '2026-08-25T12:00:00.000Z',
          pricingSnapshotSource: 'station.bedrock-model-catalog:us-west-2',
        },
      },
    ],
    receipts: [
      {
        id: 'receipt',
        stationId: 'local',
        provider: 'codex',
        conversationId: 'conversation/one',
        taskId: 'task one',
        pricing: { status: 'unpriced' },
      },
    ],
  },
  isLoading: false,
  error: null,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useUsageRollupQuery: () => result,
}));

import { UsageRollupPanel } from './UsageRollupPanel';

describe('UsageRollupPanel (station#4135)', () => {
  test('explains mixed money and source gaps without rendering them as zero', () => {
    render(<UsageRollupPanel />);
    expect(screen.getByText('Mixed: 1.0000 USD, 2.0000 EUR')).toBeTruthy();
    expect(screen.getByText('Partially priced')).toBeTruthy();
    expect(
      screen.getByText(
        /catalog-usd from station\.bedrock-model-catalog:us-west-2, captured/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Coverage incomplete' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Missing usage sources' }),
    ).toBeTruthy();
    expect(screen.getByText(/2\/3 turns reported usage/)).toBeTruthy();
    expect(
      screen.getByText(/100 receipts omitted for 2026-08-19 to 2026-08-25/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /codex: offline; window 2026-08-19 to 2026-08-25; stale freshness; 0\/2 turns reported/,
      ),
    ).toBeTruthy();
  });

  test('offers encoded conversation and Task drilldown links', () => {
    render(<UsageRollupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Receipt drilldown/ }));
    expect(
      screen.getByRole('link', { name: 'Conversation' }).getAttribute('href'),
    ).toBe('/chat/conversation%2Fone');
    expect(
      screen.getByRole('link', { name: 'Task' }).getAttribute('href'),
    ).toBe('/tasks/task%20one');
  });

  test('calls an empty coverage result never reported instead of zero usage', () => {
    result.data.coverage = [];
    render(<UsageRollupPanel />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Usage never reported' }),
    );
    expect(
      screen.getByText(
        'No Station or provider reported usage for this window.',
      ),
    ).toBeTruthy();
  });
});
