/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UsageStatsPanel } from '../components/usage-stats/UsageStatsPanel';

/**
 * archive#3093 period selector + trend, pinned against the panel's three
 * data-honesty rules:
 * 1. Period figures come only from the server's rangeSummary over daily
 *    history, never from lifetime fields — and carry the engine-session
 *    coverage sentence whenever that history is known-incomplete.
 * 2. An absent day is "No activity recorded", never a fabricated $0.00.
 * 3. The lifetime sections do not change when the period changes, and say
 *    so — a control must not sit above numbers it does not filter
 *    (the archive#3214/#3222 defect class).
 */

const sdkState = vi.hoisted(() => ({
  ranged: { data: undefined as unknown, error: null as unknown },
  calls: [] as Array<{ from: string; to: string }>,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useResetUsageStatsMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useActivityUsageQuery: (from: string, to: string) => {
    sdkState.calls.push({ from, to });
    return {
      data: sdkState.ranged.data,
      error: sdkState.ranged.error,
      refetch: vi.fn(),
    };
  },
}));

const analyticsState = vi.hoisted(() => ({
  usageStats: null as unknown,
  loading: false,
  error: null as unknown,
  refresh: vi.fn(),
  rescan: vi.fn(),
}));

vi.mock('../contexts/AnalyticsContext', () => ({
  useAnalytics: () => analyticsState,
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ModelsContext', () => ({ useModels: () => [] }));
vi.mock('../components/modals/ConfirmModal', () => ({
  ConfirmModal: () => null,
}));
vi.mock('../components/usage-stats/UsageDrillDownModal', () => ({
  UsageDrillDownModal: () => null,
}));

const ENGINE_COVERAGE = {
  sessions: 3,
  sessionsReportingTokens: 2,
  sessionsReportingCost: 1,
};

function buildLifetimeStats(overrides: Record<string, unknown> = {}) {
  return {
    lifetime: {
      totalMessages: 400,
      totalConversations: 40,
      totalInputTokens: 100,
      totalOutputTokens: 100,
      totalCost: 20,
      uniqueAgents: ['agent-a'],
      engineUsageCoverage: ENGINE_COVERAGE,
      ...overrides,
    },
    byModel: {
      'model-x': { messages: 100, inputTokens: 1, outputTokens: 1, cost: 5 },
    },
    byAgent: { 'agent-a': { conversations: 4, messages: 50, cost: 2 } },
    byDate: {},
  };
}

/** What the real server returns for `?from&to`: full stats, filtered byDate,
 *  plus its own rangeSummary. */
function buildRangedData(overrides: Record<string, unknown> = {}) {
  return {
    ...buildLifetimeStats(),
    byDate: {
      '2026-08-17': { messages: 3, cost: 0.5, inputTokens: 0, outputTokens: 0 },
      '2026-08-01': {
        messages: 9,
        cost: 0.73,
        inputTokens: 0,
        outputTokens: 0,
      },
    },
    rangeSummary: {
      totalDays: 30,
      activeDays: 2,
      totalMessages: 12,
      totalCost: 1.23,
      avgPerDay: 6,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
  sdkState.ranged.data = undefined;
  sdkState.ranged.error = null;
  sdkState.calls.length = 0;
  analyticsState.usageStats = buildLifetimeStats();
  analyticsState.loading = false;
  analyticsState.error = null;
});

afterEach(() => {
  vi.useRealTimers();
});

function selectPeriod(label: string) {
  // Native radios (fieldset), not aria-pressed buttons — the selector is a
  // mutually-exclusive choice, and radio semantics carry the checked state.
  fireEvent.click(screen.getByRole('radio', { name: label }));
}

describe('UsageStatsPanel period selector', () => {
  test('defaults to All time, reading the lifetime fields', () => {
    render(<UsageStatsPanel />);
    expect(
      (screen.getByRole('radio', { name: 'All time' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    // Lifetime cards, including the figures only the lifetime store carries.
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('$20.00')).toBeTruthy();
    // The all-time view fetches no range and renders no daily chart.
    expect(sdkState.calls).toHaveLength(0);
    expect(document.querySelector('.usage-trend')).toBeNull();
    // Everything on screen is lifetime, so no scope divider is needed.
    expect(screen.queryByText(/period above does not filter/)).toBeNull();
  });

  test('a bounded period requests the UTC window from the server', () => {
    sdkState.ranged.data = buildRangedData();
    render(<UsageStatsPanel />);
    selectPeriod('30 days');
    expect(sdkState.calls[0]).toEqual({
      from: '2026-07-20',
      to: '2026-08-18',
    });
    selectPeriod('Today');
    expect(sdkState.calls.at(-1)).toEqual({
      from: '2026-08-18',
      to: '2026-08-18',
    });
  });

  test('period figures come from rangeSummary, never the lifetime sums', () => {
    sdkState.ranged.data = buildRangedData();
    render(<UsageStatsPanel />);
    selectPeriod('30 days');
    // The server's range sums.
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
    expect(screen.getByText('2/30')).toBeTruthy();
    expect(screen.getByText('$0.1025')).toBeTruthy(); // 1.23 / 12
    // The dishonest-completeness case: the lifetime totals — which include
    // engine sessions daily history cannot see — must not appear as period
    // figures.
    expect(screen.queryByText('$20.00')).toBeNull();
    expect(screen.queryByText('400')).toBeNull();
    // Conversations has no daily dimension, so no Conversations card may sit
    // under a period selector claiming to scope it.
    expect(screen.queryByText('Conversations')).toBeNull();
  });

  test('discloses the engine-session gap in daily history', () => {
    sdkState.ranged.data = buildRangedData();
    render(<UsageStatsPanel />);
    selectPeriod('30 days');
    expect(
      screen.getByText(
        '3 engine sessions are counted in lifetime totals but not in daily history, so period figures cover Station-recorded activity only.',
      ),
    ).toBeTruthy();
  });

  test('no gap sentence when no engine sessions exist', () => {
    sdkState.ranged.data = buildRangedData({
      lifetime: {
        ...buildLifetimeStats().lifetime,
        engineUsageCoverage: undefined,
      },
    });
    render(<UsageStatsPanel />);
    selectPeriod('30 days');
    expect(screen.queryByText(/engine session/)).toBeNull();
  });

  test('the lifetime breakdowns do not change with the period, and say so', () => {
    sdkState.ranged.data = buildRangedData();
    render(<UsageStatsPanel />);
    const lifetimeRow = () => screen.getByText('100 msgs · $5.00');
    expect(lifetimeRow()).toBeTruthy();
    selectPeriod('30 days');
    // Identical breakdown figures — the selector does not filter them...
    expect(lifetimeRow()).toBeTruthy();
    expect(screen.getByText('50 msgs · $2.00')).toBeTruthy();
    //...and the section now says so instead of silently sitting under the
    // selector.
    expect(
      screen.getByRole('heading', { level: 4, name: 'All time' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Lifetime figures — the period above does not filter them.',
      ),
    ).toBeTruthy();
    // Back to All time: divider gone, breakdown unchanged.
    selectPeriod('All time');
    expect(lifetimeRow()).toBeTruthy();
    expect(screen.queryByText(/period above does not filter/)).toBeNull();
  });

  test('renders daily bars: recorded days labeled with both measures, absent days as "No activity recorded"', () => {
    sdkState.ranged.data = buildRangedData();
    const { container } = render(<UsageStatsPanel />);
    selectPeriod('30 days');
    const bars = container.querySelectorAll('.usage-trend__bar');
    expect(bars).toHaveLength(30);
    const titles = Array.from(bars).map((bar) => bar.getAttribute('title'));
    expect(
      titles.filter((title) => title?.includes('No activity recorded')),
    ).toHaveLength(28);
    expect(
      titles.some((title) => title?.includes('$0.5000 · 3 messages')),
    ).toBe(true);
    expect(
      titles.some((title) => title?.includes('$0.7300 · 9 messages')),
    ).toBe(true);
    // No absent day claims a measurement.
    for (const title of titles) {
      if (title?.includes('No activity recorded')) {
        expect(title).not.toContain('$');
      }
    }
  });

  test('an empty period is an empty state, not $0.00 cards', () => {
    sdkState.ranged.data = buildRangedData({
      byDate: {},
      rangeSummary: {
        totalDays: 7,
        activeDays: 0,
        totalMessages: 0,
        totalCost: 0,
        avgPerDay: 0,
      },
    });
    render(<UsageStatsPanel />);
    selectPeriod('7 days');
    expect(screen.getByText('Nothing recorded in this period')).toBeTruthy();
    // The gap sentence still applies: "no recorded daily activity" is not a
    // claim that nothing ran.
    expect(screen.getByText(/3 engine sessions are counted/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(document.querySelector('.usage-trend')).toBeNull();
  });

  test('period loading and error states', () => {
    sdkState.ranged.data = undefined;
    render(<UsageStatsPanel />);
    selectPeriod('7 days');
    expect(screen.getByRole('status', { name: 'Loading period' })).toBeTruthy();

    sdkState.ranged.error = new Error('boom');
    selectPeriod('30 days');
    expect(screen.getByText('Could not load this period')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
