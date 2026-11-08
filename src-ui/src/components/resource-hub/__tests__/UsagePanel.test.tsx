/**
 * @vitest-environment jsdom
 */

import type { UsageRollup } from '@kontourai/station-contracts/usage-rollup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { UsagePanel, type UsagePanelState } from '../UsagePanel';

function rollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    window: { from: '2026-10-01', to: '2026-10-07' },
    rows: [
      {
        key: 'day-2',
        stationId: 'local',
        provider: 'opencode',
        day: '2026-10-02',
        inputTokens: 1000,
        outputTokens: 200,
        pricingStatus: 'unpriced',
        receiptCount: 3,
      },
    ],
    receipts: [],
    coverage: [
      {
        stationId: 'local',
        state: 'complete',
        window: { from: '2026-10-01', to: '2026-10-07' },
      },
    ],
    ...overrides,
  } as UsageRollup;
}

function panel(state: UsagePanelState) {
  return render(
    <UsagePanel
      state={state}
      days={7}
      onDaysChange={() => undefined}
      label="OpenCode"
    />,
  );
}

describe('UsagePanel', () => {
  test('loading', () => {
    panel({ kind: 'loading' });
    expect(screen.getByLabelText('Loading usage')).toBeTruthy();
  });

  test('empty, when every source answered', () => {
    panel({ kind: 'ready', data: rollup({ rows: [] }) });
    expect(screen.getByText('Usage will appear here')).toBeTruthy();
  });

  test('empty because sources were missing is not the same as none', () => {
    panel({
      kind: 'ready',
      data: rollup({
        rows: [],
        coverage: [
          {
            stationId: 'local',
            state: 'partial',
            window: { from: '2026-10-01', to: '2026-10-07' },
          },
        ],
      }),
    });
    expect(screen.getByText('Usage unavailable')).toBeTruthy();
  });

  test('error offers a retry that reads again', () => {
    const onRetry = vi.fn();
    panel({ kind: 'error', error: new Error('boom'), onRetry });
    expect(screen.getByText('Usage could not be loaded')).toBeTruthy();
    expect(screen.queryByText('boom')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('partial figures say activity is missing', () => {
    panel({
      kind: 'ready',
      data: rollup({
        coverage: [
          {
            stationId: 'local',
            state: 'partial',
            window: { from: '2026-10-01', to: '2026-10-07' },
          },
        ],
      }),
    });
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('Some activity is missing.')).toBeTruthy();
  });

  test('a day with no row is drawn as unreported, not zero', () => {
    panel({ kind: 'ready', data: rollup() });
    expect(screen.getByTitle('2026-10-01: Not reported')).toBeTruthy();
    expect(screen.getByTitle('2026-10-02: 1,200')).toBeTruthy();
    expect(
      screen
        .getByTitle('2026-10-01: Not reported')
        .hasAttribute('data-unreported'),
    ).toBe(true);
  });

  test.each([
    ['access-denied', 'Usage needs credential-management access'],
    ['context-only', 'Context use only'],
    ['unsupported', "Update Station to see this engine's usage"],
  ] as const)(
    '%s states why there are no figures, never zero',
    (kind, text) => {
      panel({ kind });
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByText('0')).toBeNull();
      expect(screen.queryByText('Tokens')).toBeNull();
    },
  );

  test('the period is a radio group', () => {
    const onDaysChange = vi.fn();
    render(
      <UsagePanel
        state={{ kind: 'loading' }}
        days={7}
        onDaysChange={onDaysChange}
        label="OpenCode"
      />,
    );
    expect(
      (screen.getByRole('radio', { name: '7 days' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(onDaysChange).toHaveBeenCalledWith(30);
  });
});
