import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import { AuthStatusBadge } from '@kontourai/station-sdk';
import { useState } from 'react';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { Button } from '../components/Button';
import { AchievementsBadge } from '../components/badges/AchievementsBadge';
import { UserIcon } from '../components/icons/UserIcon';
import { UserDetailModal } from '../components/modals/UserDetailModal';
import { InsightsDashboard } from '../components/monitoring/InsightsDashboard';
import { StationPeoplePanel } from '../components/profile/StationPeoplePanel';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import {
  buildTrendDays,
  describeDailyHistoryGap,
} from '../components/usage-stats/period';
import { UsageRollupPanel } from '../components/usage-stats/UsageRollupPanel';
import { UsageStatsPanel } from '../components/usage-stats/UsageStatsPanel';
import { describeCostCoverage } from '../components/usage-stats/UsageSummaryCards';
import { useAnalytics } from '../contexts/AnalyticsContext';
import { useAuth } from '../contexts/AuthContext';
import { pluginRegistry } from '../core/PluginRegistry';
import './ProfilePage.css';
import '../views/page-layout.css';

function buildUsageGraphPoints(
  usageStats: NonNullable<ReturnType<typeof useAnalytics>['usageStats']>,
) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 13 * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  const days = buildTrendDays(usageStats.byDate, from, to);
  if (!days.some((day) => day.recorded)) return [];
  return days.map((day) => ({
    ...day,
    label: new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }),
    value: day.messages,
  }));
}

function ProfileUsageGraph({
  usageStats,
}: {
  usageStats: NonNullable<ReturnType<typeof useAnalytics>['usageStats']> | null;
}) {
  const points = usageStats ? buildUsageGraphPoints(usageStats) : [];
  const maxValue = Math.max(1, ...points.map((point) => point.value));

  return (
    <div
      className="profile-usage-graph"
      aria-label="Usage activity overview"
      role="img"
    >
      <div className="profile-usage-graph__header">
        <span className="profile-card__section-title">Usage activity</span>
        <span className="profile-usage-graph__caption">Last 14 UTC days</span>
      </div>

      {points.length === 0 ? (
        <Empty
          variant="compact"
          icon={
            <div className="profile-usage-graph__usage-bars" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          }
          label="Daily activity not recorded in the last 14 days"
        />
      ) : (
        <div className="profile-usage-graph__bars">
          {points.map((point) => (
            <div key={point.date} className="profile-usage-graph__column">
              <div
                className="profile-usage-graph__bar"
                style={{
                  height:
                    point.value > 0
                      ? `${(point.value / maxValue) * 6}rem`
                      : '2px',
                }}
                title={
                  point.recorded
                    ? `${point.label}: ${point.value.toLocaleString()} recorded messages`
                    : `${point.label}: no daily record`
                }
              />
              <span className="profile-usage-graph__label">{point.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProfilePage() {
  const { usageStats, loading, error, refresh, rescan } = useAnalytics();
  const { user } = useAuth();

  const achievementLinks = pluginRegistry.getLinks('achievements');
  const userName = user?.name || user?.alias || 'User';
  const totalMessages = usageStats?.lifetime.totalMessages || 0;
  const totalCost = usageStats?.lifetime.totalCost || 0;
  const [showUserLookup, setShowUserLookup] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<Error | null>(null);
  const costCoverage = describeCostCoverage(
    usageStats?.lifetime.engineUsageCoverage,
  );
  const historyGap = describeDailyHistoryGap(
    usageStats?.lifetime.engineUsageCoverage,
  );
  const rebuild = async () => {
    setRebuilding(true);
    setRebuildError(null);
    try {
      await rescan();
    } catch (failure) {
      setRebuildError(
        failure instanceof Error ? failure : new Error(String(failure)),
      );
    } finally {
      setRebuilding(false);
    }
  };

  // Header first, skeleton only the awaited body (6-OPS-23). The whole page —
  // eyebrow, name, every section heading — used to be replaced by the string
  // "Loading profile...", which is both a twelfth loading vocabulary and a
  // route that renders nothing identifying itself while it waits.
  if (loading && !usageStats) {
    return (
      // The header C2 wrote here is the FRAME's now (SHELL-11): the route
      // renders it above this body, on screen throughout the wait, so a
      // second one below it would be the page's name printed twice.
      <div className="profile-page">
        <SkeletonBlock count={3} label="Loading profile" />
      </div>
    );
  }

  // `useAnalytics` already derived this error and the page ignored
  // it, so a failed usage read settled with no stats and was drawn as "No
  // usage data yet" — a claim about the user's activity over a read that
  // never answered. Same header-first shape as the wait above: the frame's
  // header stays up, the body carries the failure.
  if (error && !usageStats) {
    return (
      <div className="profile-page">
        <ErrorState
          title="Unable to load profile"
          description={describeReadFailure(error)}
          action={
            <Button size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="profile-page">
      <div className="profile-container">
        <div className="profile-usage-status">
          <div>
            <p>Usage on this Station · updates while this page is open.</p>
            <p>
              {usageStats?.snapshot?.rescannedAt
                ? `Snapshot rebuilt ${new Date(usageStats.snapshot.rescannedAt).toLocaleString()}`
                : 'Snapshot rebuild time unavailable'}
            </p>
            <p>
              Counts combine saved messages and completed engine turns. Costs
              may combine estimates and provider reports; they are not a billing
              statement.
            </p>
          </div>
          <Button
            size="sm"
            disabled={rebuilding}
            onClick={() => void rebuild()}
          >
            {rebuilding ? 'Rebuilding…' : 'Rebuild usage'}
          </Button>
        </div>
        {(error || rebuildError) && (
          <ErrorState
            variant="compact"
            title="Usage refresh failed"
            description={`Showing the last available snapshot. ${describeReadFailure(rebuildError || error)}`}
            action={
              <Button
                size="sm"
                onClick={rebuildError ? () => void rebuild() : refresh}
              >
                Retry
              </Button>
            }
          />
        )}
        {usageStats?.snapshot?.engineUsage === 'unavailable' && (
          <p role="alert">
            Engine usage could not be read during the last rebuild. These totals
            may be incomplete.
          </p>
        )}
        {usageStats?.snapshot?.skippedMessages > 0 && (
          <p role="alert">
            {usageStats.snapshot.skippedMessages} saved message records could
            not be read during the last rebuild.
          </p>
        )}
        <div className="profile-card">
          <div className="profile-card__edit-btn">
            <AuthStatusBadge expanded />
          </div>
          <div className="profile-hero-content">
            <UserIcon size={120} className="profile-card__avatar" />
            <div className="profile-hero-info">
              <div>
                <div className="profile-card__info">
                  <div className="profile-card__name-row">
                    {/* The page title is the frame's; this is the card's own
                        heading, one level down. Classes unchanged, so the
                        rendered size is exactly what it was. */}
                    <h2 className="profile-hero-title profile-card__name">
                      {user?.name ? (
                        <>
                          {user.name}{' '}
                          <span className="profile-card__alias">
                            (
                            <button
                              type="button"
                              onClick={() => setShowUserLookup(true)}
                              className="profile-card__alias-btn"
                            >
                              {user.alias}
                            </button>
                            )
                          </span>
                        </>
                      ) : user?.alias ? (
                        <button
                          type="button"
                          onClick={() => setShowUserLookup(true)}
                          className="profile-card__copy-btn"
                        >
                          {userName}
                        </button>
                      ) : (
                        userName
                      )}
                    </h2>
                    {usageStats?.lifetime.firstMessageDate && (
                      <span className="profile-card__title">
                        First daily record (UTC){' '}
                        {new Date(
                          usageStats.lifetime.firstMessageDate,
                        ).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                      </span>
                    )}
                  </div>
                  {user?.title && (
                    <span className="profile-card__detail">{user.title}</span>
                  )}
                  {user?.email && (
                    <span className="profile-card__detail--muted">
                      {user.email}
                    </span>
                  )}
                </div>
              </div>
              <p className="profile-hero-subtitle">
                {totalMessages.toLocaleString()} messages and engine turns
                recorded on this Station
              </p>
              {totalCost > 0 && (
                <div className="profile-hero-badges">
                  <div className="profile-badge profile-badge-primary">
                    ${totalCost.toFixed(2)} recorded cost
                  </div>
                </div>
              )}
              {costCoverage && <p>{costCoverage}</p>}
              <ProfileUsageGraph usageStats={usageStats ?? null} />
              <p>Daily history covers Station-recorded messages only.</p>
              {historyGap && <p>{historyGap}</p>}
            </div>
          </div>
        </div>

        <div className="profile-card">
          <StationPeoplePanel />
        </div>

        <div className="profile-stats-grid">
          <div className="profile-card">
            <UsageStatsPanel />
          </div>
          <div className="profile-card">
            <AchievementsBadge links={achievementLinks} />
          </div>
        </div>

        <div className="profile-card">
          <UsageRollupPanel />
        </div>

        <div className="profile-card">
          <InsightsDashboard />
        </div>

        {totalMessages > 0 && (
          <div className="profile-timeline">
            <h3 className="profile-timeline-title">📈 Activity History</h3>
            <ActivityTimeline />
          </div>
        )}
      </div>
      {showUserLookup && user?.alias && (
        <UserDetailModal
          alias={user.alias}
          onClose={() => setShowUserLookup(false)}
        />
      )}
    </div>
  );
}
