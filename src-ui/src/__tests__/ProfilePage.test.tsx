/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const buildPopulatedUsageStats = vi.hoisted(() => () => ({
  lifetime: {
    totalMessages: 18,
    totalCost: 2.75,
    firstMessageDate: '2026-04-01T10:00:00Z',
  },
  byModel: {},
  byAgent: {},
  byDate: Object.fromEntries(
    Array.from({ length: 14 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      return [
        `2026-04-${day}`,
        { messages: index % 3 === 0 ? index + 1 : 0, cost: index * 0.05 },
      ];
    }),
  ),
}));

const refreshAnalytics = vi.hoisted(() => vi.fn());
const analyticsState = vi.hoisted(() => ({
  loading: false,
  error: null as unknown,
  usageStats: null as ReturnType<typeof buildPopulatedUsageStats> | null,
  refresh: refreshAnalytics,
}));

vi.mock('@kontourai/station-sdk', () => ({
  AuthStatusBadge: () => <div>Auth badge</div>,
  useUsageRollupQuery: () => ({
    data: { coverage: [], rows: [], receipts: [] },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../components/badges/AchievementsBadge', () => ({
  AchievementsBadge: () => <div>Achievements</div>,
}));

vi.mock('../components/ActivityTimeline', () => ({
  ActivityTimeline: () => <div>Timeline</div>,
}));

vi.mock('../components/monitoring/InsightsDashboard', () => ({
  InsightsDashboard: () => <div>Insights</div>,
}));

vi.mock('../components/usage-stats/UsageStatsPanel', () => ({
  UsageStatsPanel: () => <div>Usage stats</div>,
}));

vi.mock('../components/modals/UserDetailModal', () => ({
  UserDetailModal: () => null,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <div>User icon</div>,
}));

vi.mock('../contexts/AnalyticsContext', () => ({
  useAnalytics: () => analyticsState,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      name: 'Casey Example',
      alias: 'casey',
      email: 'casey@example.com',
      title: 'Operator',
    },
  }),
}));

vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    getLinks: () => [],
  },
}));

import { ProfilePage } from '../pages/ProfilePage';

describe('ProfilePage', () => {
  beforeEach(() => {
    analyticsState.loading = false;
    analyticsState.error = null;
    analyticsState.usageStats = buildPopulatedUsageStats();
    refreshAnalytics.mockReset();
  });

  test('renders a compact populated usage graph inside the hero card', () => {
    const { container } = render(<ProfilePage />);

    expect(screen.getByLabelText('Usage activity overview')).toBeTruthy();
    expect(screen.getByText(/Recent activity/)).toBeTruthy();
    expect(
      container.querySelectorAll('.profile-usage-graph__bar'),
    ).toHaveLength(14);
  });

  test('renders the empty hero graph state when no recent usage exists', () => {
    analyticsState.usageStats = {
      lifetime: {
        totalMessages: 0,
        totalCost: 0,
        firstMessageDate: '',
      },
      byModel: {},
      byAgent: {},
      byDate: {},
    };

    render(<ProfilePage />);

    expect(screen.getByText(/No usage data yet/i)).toBeTruthy();
  });

  // `useAnalytics` already derived the usage read's error and this
  // page ignored it, so a failed read settled with no stats and was drawn as
  // "No usage data yet" — a claim about the user's own activity made over a
  // request that never answered.
  test('renders the read failure, not "No usage data yet", when the usage read errors', () => {
    analyticsState.usageStats = null;
    analyticsState.error = new Error('usage read failed');

    render(<ProfilePage />);

    expect(screen.queryByText(/No usage data yet/i)).toBeNull();
    expect(screen.getByText('Unable to load profile')).toBeTruthy();
    expect(screen.getByText('usage read failed')).toBeTruthy();
    // Header first, in a failure exactly as in a wait (6-OPS-23): the page
    // title is the frame's (page-frame-registry.ts) and never depended on
    // the read, so the page itself renders only the failure here.

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshAnalytics).toHaveBeenCalledTimes(1);
  });

  test('the wait outranks the failure while the first usage read is in flight', () => {
    analyticsState.usageStats = null;
    analyticsState.loading = true;
    analyticsState.error = new Error('usage read failed');

    render(<ProfilePage />);

    expect(screen.getByLabelText('Loading profile')).toBeTruthy();
    expect(screen.queryByText('Unable to load profile')).toBeNull();
  });
});
