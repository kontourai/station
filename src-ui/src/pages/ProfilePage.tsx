import { AuthStatusBadge } from '@kontourai/station-sdk';
import { useState } from 'react';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { Button } from '../components/Button';
import { AchievementsBadge } from '../components/badges/AchievementsBadge';
import { UserIcon } from '../components/icons/UserIcon';
import { UserDetailModal } from '../components/modals/UserDetailModal';
import { InsightsDashboard } from '../components/monitoring/InsightsDashboard';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import { UsageRollupPanel } from '../components/usage-stats/UsageRollupPanel';
import { UsageStatsPanel } from '../components/usage-stats/UsageStatsPanel';
import { useAnalytics } from '../contexts/AnalyticsContext';
import { useAuth } from '../contexts/AuthContext';
import { pluginRegistry } from '../core/PluginRegistry';
import './ProfilePage.css';
import '../views/page-layout.css';

type UsageByDateEntry = {
  cost?: number;
  messages?: number;
};

function buildUsageGraphPoints(
  usageStats: NonNullable<ReturnType<typeof useAnalytics>['usageStats']>,
) {
  const byDateEntries = Object.entries(
    (usageStats.byDate || {}) as Record<string, UsageByDateEntry>,
  ).sort(([left], [right]) => left.localeCompare(right));

  if (byDateEntries.length > 0) {
    return byDateEntries.slice(-14).map(([date, stats]) => ({
      label: new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
      value: stats.messages || 0,
    }));
  }

  if (usageStats.lifetime.totalMessages > 0) {
    return [
      {
        label: 'All time',
        value: usageStats.lifetime.totalMessages,
      },
    ];
  }

  return [];
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
        <span className="profile-usage-graph__caption">
          {points.length > 1 ? 'Recent activity' : 'Usage snapshot'}
        </span>
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
          label="No usage data yet"
        />
      ) : (
        <div className="profile-usage-graph__bars">
          {points.map((point) => (
            <div key={point.label} className="profile-usage-graph__column">
              <div
                className="profile-usage-graph__bar"
                style={{
                  height: `${Math.max((point.value / maxValue) * 100, 12)}%`,
                }}
                title={`${point.label}: ${point.value.toLocaleString()} messages`}
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
  const { usageStats, loading, error, refresh } = useAnalytics();
  const { user } = useAuth();

  const achievementLinks = pluginRegistry.getLinks('achievements');
  const userName = user?.name || user?.alias || 'User';
  const totalMessages = usageStats?.lifetime.totalMessages || 0;
  const totalCost = usageStats?.lifetime.totalCost || 0;
  const [showUserLookup, setShowUserLookup] = useState(false);

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

  // Review M2: `useAnalytics` already derived this error and the page ignored
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
                        Joined{' '}
                        {new Date(
                          usageStats.lifetime.firstMessageDate,
                        ).toLocaleDateString()}
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
                {totalMessages === 0
                  ? 'Start your journey with your first message'
                  : totalMessages === 1
                    ? "🎉 You've sent your first message!"
                    : totalMessages < 10
                      ? `${totalMessages} messages sent - you're getting started!`
                      : totalMessages < 100
                        ? `${totalMessages} messages - you're on a roll!`
                        : `${totalMessages} messages - power user! 🚀`}
              </p>
              {totalCost > 0 && (
                <div className="profile-hero-badges">
                  <div className="profile-badge profile-badge-primary">
                    💰 ${totalCost.toFixed(2)} spent
                  </div>
                  <div className="profile-badge profile-badge-secondary">
                    📊 ${(totalCost / Math.max(totalMessages, 1)).toFixed(4)}
                    /msg
                  </div>
                </div>
              )}
              <ProfileUsageGraph usageStats={usageStats ?? null} />
            </div>
          </div>
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
