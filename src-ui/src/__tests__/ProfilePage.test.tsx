/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
      const day = new Date(Date.now() - (13 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return [
        day,
        { messages: index % 3 === 0 ? index + 1 : 0, cost: index * 0.05 },
      ];
    }),
  ),
}));

const refreshAnalytics = vi.hoisted(() => vi.fn());
const retryAnalytics = vi.hoisted(() =>
  vi.fn<
    ReturnType<
      typeof import('../contexts/AnalyticsContext').useAnalytics
    >['retryUsage']
  >(),
);
const rescanAnalytics = vi.hoisted(() => vi.fn());
const analyticsState = vi.hoisted(() => ({
  loading: false,
  error: null as unknown,
  usageStats: null as ReturnType<typeof buildPopulatedUsageStats> | null,
  refresh: refreshAnalytics,
  retryUsage: retryAnalytics,
  rescan: rescanAnalytics,
}));

vi.mock('@kontourai/station-sdk', async () => {
  const { useQueryClient } = await import('@tanstack/react-query');
  return { AuthStatusBadge: () => <div>Auth badge</div>, useQueryClient };
});
vi.mock('@kontourai/station-sdk/usage-rollup-query', () => ({
  useUsageRollupQuery: () => ({
    data: { coverage: [], rows: [], receipts: [] },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../components/profile/StationPeoplePanel', () => ({
  StationPeoplePanel: () => <div>Paired profiles</div>,
}));
vi.mock('../components/profile/MyAccessPanel', () => ({
  MyAccessPanel: () => <div>My access</div>,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../components/usage-stats/StationUsagePanel', () => ({
  StationUsagePanel: () => <div>Station operator overview</div>,
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

let profileClient: QueryClient;
function renderProfile() {
  return render(<ProfilePage />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={profileClient}>
        {children}
      </QueryClientProvider>
    ),
  });
}

describe('ProfilePage', () => {
  beforeEach(() => {
    profileClient = new QueryClient();
    analyticsState.loading = false;
    analyticsState.error = null;
    analyticsState.usageStats = buildPopulatedUsageStats();
    refreshAnalytics.mockReset();
    retryAnalytics
      .mockReset()
      .mockRejectedValue(new Error('usage read failed'));
    rescanAnalytics.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => profileClient.clear());

  test('renders a compact populated usage graph inside the hero card', () => {
    const { container } = renderProfile();

    expect(screen.getByLabelText('Usage activity overview')).toBeTruthy();
    expect(screen.getByText(/Last 14 UTC days/)).toBeTruthy();
    expect(
      container.querySelectorAll('.profile-usage-graph__bar'),
    ).toHaveLength(14);
  });

  test('mounts diagnostic reads only while the disclosure is open', async () => {
    renderProfile();
    expect(screen.queryByText('Insights')).toBeNull();
    const summary = screen.getByText('Diagnostics').closest('summary')!;
    fireEvent.click(summary);
    await waitFor(() => expect(screen.getByText('Insights')).toBeTruthy());
    fireEvent.click(summary);
    await waitFor(() => expect(screen.queryByText('Insights')).toBeNull());
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

    renderProfile();

    expect(screen.getByText(/Daily activity not recorded/i)).toBeTruthy();
  });

  test('does not relabel old daily history or lifetime totals as recent activity', () => {
    analyticsState.usageStats = buildPopulatedUsageStats();
    analyticsState.usageStats.byDate = {
      '2020-01-01': { messages: 18, cost: 2.75 },
    };
    const { container } = renderProfile();
    expect(screen.getByText(/Daily activity not recorded/)).toBeTruthy();
    expect(container.querySelector('.profile-usage-graph__bar')).toBeNull();
    expect(screen.queryByText(/spent/)).toBeNull();
    expect(screen.queryByText(/Joined/)).toBeNull();
  });

  test('discloses failed background refreshes over a retained snapshot', () => {
    analyticsState.error = new Error('Station offline');
    renderProfile();
    expect(screen.getByText('Usage refresh failed')).toBeTruthy();
    expect(
      screen.getByText(/Showing the last available snapshot/),
    ).toBeTruthy();
  });

  test('reports a failed rebuild instead of presenting it as refreshed usage', async () => {
    rescanAnalytics.mockRejectedValueOnce(new Error('Rebuild unavailable'));
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild usage' }));
    await waitFor(() =>
      expect(screen.getByText(/Rebuild unavailable/)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByText('Usage refresh failed')).toBeNull(),
    );
    expect(rescanAnalytics).toHaveBeenCalledTimes(2);
  });

  // `useAnalytics` already derived the usage read's error and this
  // page ignored it, so a failed read settled with no stats and was drawn as
  // "No usage data yet" — a claim about the user's own activity made over a
  // request that never answered.
  test('renders the read failure, not "No usage data yet", when the usage read errors', async () => {
    analyticsState.usageStats = null;
    analyticsState.error = new Error('usage read failed');

    renderProfile();

    expect(screen.queryByText(/Daily activity not recorded/i)).toBeNull();
    expect(screen.getByText('Unable to load profile')).toBeTruthy();
    expect(screen.getByText('usage read failed')).toBeTruthy();
    expect(screen.getByText('My access')).toBeTruthy();
    expect(screen.getByText('Paired people')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(retryAnalytics).toHaveBeenCalledTimes(1);
  });

  test('the wait outranks the failure while the first usage read is in flight', () => {
    analyticsState.usageStats = null;
    analyticsState.loading = true;
    analyticsState.error = new Error('usage read failed');

    renderProfile();

    expect(screen.getByLabelText('Loading profile')).toBeTruthy();
    expect(screen.queryByText('Unable to load profile')).toBeNull();
    expect(screen.getByText('My access')).toBeTruthy();
    expect(screen.getByText('Paired people')).toBeTruthy();
  });

  test('keeps the access disclosure open through analytics pending, failure, Retry and recovery', async () => {
    const { rerender } = renderProfile();
    const summary = screen.getByText('Paired people').closest('summary')!;
    fireEvent.click(summary);
    await waitFor(() =>
      expect(screen.getByText('Paired profiles')).toBeTruthy(),
    );

    analyticsState.usageStats = null;
    analyticsState.loading = true;
    rerender(<ProfilePage />);
    expect(screen.getByLabelText('Loading profile')).toBeTruthy();
    expect(screen.getByText('My access')).toBeTruthy();
    expect(screen.getByText('Paired profiles')).toBeTruthy();

    analyticsState.loading = false;
    analyticsState.error = new Error('usage read failed');
    rerender(<ProfilePage />);
    expect(screen.getByText('usage read failed')).toBeTruthy();
    expect(screen.getByText('My access')).toBeTruthy();
    expect(screen.getByText('Paired profiles')).toBeTruthy();
    expect(screen.queryByText(/Daily activity not recorded/i)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(retryAnalytics).toHaveBeenCalledTimes(1);

    analyticsState.error = null;
    analyticsState.usageStats = buildPopulatedUsageStats();
    rerender(<ProfilePage />);
    expect(screen.getByLabelText('Usage activity overview')).toBeTruthy();
    expect(screen.queryByText('usage read failed')).toBeNull();
    expect(screen.getByText('My access')).toBeTruthy();
    expect(screen.getByText('Paired profiles')).toBeTruthy();
  });
});
