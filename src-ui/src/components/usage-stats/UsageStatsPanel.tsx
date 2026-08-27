import {
  useActivityUsageQuery,
  useResetUsageStatsMutation,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { log } from '@/utils/logger';
import { useAgents } from '../../contexts/AgentsContext';
import { useAnalytics } from '../../contexts/AnalyticsContext';
import { useModels } from '../../contexts/ModelsContext';
import {
  CalendarGlyph,
  ChartGlyph,
  MessageGlyph,
  MoneyGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import { ConfirmModal } from '../modals/ConfirmModal';
import { Empty, ErrorState, SkeletonBlock, SkeletonList } from '../state';
import {
  buildTrendDays,
  describeDailyHistoryGap,
  periodRange,
  type UsagePeriod,
} from './period';
import { StatCard } from './StatCard';
import { UsageBreakdownSection } from './UsageBreakdownSection';
import { UsageDrillDownModal } from './UsageDrillDownModal';
import { UsagePeriodSelector } from './UsagePeriodSelector';
import { UsageSummaryCards } from './UsageSummaryCards';
import { UsageTrendChart } from './UsageTrendChart';
import { getAverageCostPerMessage, getTotalUsageConversations } from './utils';
import './UsageStatsPanel.css';

type DrillDownType = 'model' | 'agent' | null;

/**
 * The period-scoped half of the panel (station#3093): summary figures from
 * the server's own `rangeSummary` (the one existing range derivation —
 * routes/operations/analytics.ts), daily bars from the window's `byDate`
 * rows, and the coverage sentence that keeps a daily-history sum from
 * reading as complete when engine sessions exist (see
 * `describeDailyHistoryGap`).
 */
function UsagePeriodSection({ from, to }: { from: string; to: string }) {
  const { data, error, refetch } = useActivityUsageQuery(from, to);

  if (error) {
    return (
      <ErrorState
        variant="compact"
        title="Could not load this period"
        action={
          <button
            type="button"
            className="usage-stats-error-button"
            onClick={() => refetch()}
          >
            Retry
          </button>
        }
      />
    );
  }
  if (!data) {
    return <SkeletonList count={2} withIcon={false} label="Loading period" />;
  }

  const rangeSummary = data.rangeSummary as
    | {
        totalDays: number;
        activeDays: number;
        totalMessages: number;
        totalCost: number;
        avgPerDay: number;
      }
    | undefined;
  const historyGap = describeDailyHistoryGap(
    data.lifetime?.engineUsageCoverage,
  );

  if (!rangeSummary) {
    // The server contract returns a rangeSummary for every ?from&to request;
    // its absence means we cannot claim any period sum, so claim none.
    return (
      <ErrorState
        variant="compact"
        title="Period summary unavailable"
        description="The server returned no period summary for this range."
      />
    );
  }

  if (rangeSummary.activeDays === 0) {
    // An empty period is an empty state — not $0.00 cards that read like a
    // measured quiet week (issue acceptance). When engine sessions exist the
    // gap sentence still applies: "no recorded daily activity" is not a
    // claim that nothing ran.
    return (
      <Empty
        variant="compact"
        icon={<CalendarGlyph />}
        label="Nothing recorded in this period"
        description={historyGap ?? undefined}
      />
    );
  }

  const avgCostPerMessage = getAverageCostPerMessage({
    totalCost: rangeSummary.totalCost,
    totalMessages: rangeSummary.totalMessages,
  });
  return (
    <>
      <div className="usage-stats-cards">
        <StatCard
          icon={<MessageGlyph />}
          label="Messages"
          value={rangeSummary.totalMessages.toLocaleString()}
          color="var(--accent-primary)"
        />
        <StatCard
          icon={<MoneyGlyph />}
          label="Cost"
          value={`$${rangeSummary.totalCost.toFixed(2)}`}
        />
        <StatCard
          icon={<ChartGlyph />}
          label="Avg/Message"
          value={`$${avgCostPerMessage.toFixed(4)}`}
        />
        <StatCard
          icon={<CalendarGlyph />}
          label="Active Days"
          value={`${rangeSummary.activeDays}/${rangeSummary.totalDays}`}
        />
      </div>
      {historyGap && <p className="usage-period-note">{historyGap}</p>}
      <UsageTrendChart days={buildTrendDays(data.byDate, from, to)} />
    </>
  );
}

export function UsageStatsPanel() {
  const { usageStats, loading, error, refresh, rescan } = useAnalytics();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const models = useModels();
  const agents = useAgents();
  const [drillDown, setDrillDown] = useState<{
    type: DrillDownType;
    id: string;
  } | null>(null);
  const [hasAutoRescanned, setHasAutoRescanned] = useState(false);
  // Default "all" keeps the panel's first render the complete lifetime
  // accounting (the only view that includes engine sessions); the bounded
  // views are one tap away.
  const [period, setPeriod] = useState<UsagePeriod>('all');
  const range = useMemo(() => periodRange(period), [period]);

  const resetMutation = useResetUsageStatsMutation({
    onSuccess: () => {
      refresh();
    },
  });

  // Auto-rescan if we have messages but no conversations
  useEffect(() => {
    if (
      !hasAutoRescanned &&
      usageStats &&
      usageStats.lifetime.totalMessages > 0
    ) {
      const hasConversations = Object.values(usageStats.byAgent).some(
        (stats: any) => (stats.conversations || 0) > 0,
      );

      if (!hasConversations) {
        setHasAutoRescanned(true);
        log.api('Auto-rescanning to populate conversation counts...');
        rescan();
      }
    }
  }, [usageStats, hasAutoRescanned, rescan]);

  if (loading && !usageStats) {
    return <SkeletonBlock count={3} label="Loading usage stats" />;
  }

  if (error) {
    return (
      <div className="usage-stats-error">
        <div className="usage-stats-error-icon">
          <WarningGlyph />
        </div>
        <div className="usage-stats-error-message">
          Error: {(error as Error)?.message ?? String(error)}
        </div>
        <button
          type="button"
          onClick={refresh}
          className="usage-stats-error-button"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!usageStats) return null;

  const { lifetime, byModel, byAgent } = usageStats;
  const avgCostPerMessage = getAverageCostPerMessage(lifetime);
  const totalConversations = getTotalUsageConversations(lifetime);

  return (
    <div className="usage-stats-panel">
      <div className="usage-stats-header">
        <h3 className="usage-stats-title">
          <span>
            <ChartGlyph />
          </span>
          <span>Usage Statistics</span>
        </h3>
        <button
          type="button"
          onClick={() => setShowResetConfirm(true)}
          disabled={resetMutation.isPending}
          className="usage-stats-reset-btn"
        >
          {resetMutation.isPending ? 'Resetting...' : 'Reset'}
        </button>
      </div>

      <ConfirmModal
        isOpen={showResetConfirm}
        title="Reset Usage Statistics"
        message="This will permanently clear all usage data including message counts, costs, and agent statistics. This cannot be undone."
        confirmLabel="Reset All"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          setShowResetConfirm(false);
          await resetMutation.mutateAsync();
        }}
        onCancel={() => setShowResetConfirm(false)}
      />

      <UsagePeriodSelector value={period} onChange={setPeriod} />

      {range ? (
        <UsagePeriodSection from={range.from} to={range.to} />
      ) : (
        <UsageSummaryCards
          avgCostPerMessage={avgCostPerMessage}
          engineUsageCoverage={lifetime.engineUsageCoverage}
          totalConversations={totalConversations}
          totalCost={lifetime.totalCost}
          totalMessages={lifetime.totalMessages}
        />
      )}

      {range && (
        <div className="usage-lifetime-divider">
          <h4>All time</h4>
          {/* The stored by-model/by-agent aggregates have no date dimension,
              so the period selector cannot filter them. Saying so beats a
              control that appears to scope numbers it doesn't (the
              station#3214/#3222 defect class). */}
          <p className="usage-period-note">
            Lifetime figures — the period above does not filter them.
          </p>
        </div>
      )}

      <UsageBreakdownSection
        agents={agents}
        byAgent={byAgent}
        byModel={byModel}
        models={models}
        onAgentClick={(agentId) => setDrillDown({ type: 'agent', id: agentId })}
        onModelClick={(modelId) => setDrillDown({ type: 'model', id: modelId })}
        totalMessages={lifetime.totalMessages}
      />

      {drillDown && (
        <UsageDrillDownModal
          type={drillDown.type}
          id={drillDown.id}
          usageStats={usageStats}
          models={models}
          agents={agents}
          onClose={() => setDrillDown(null)}
        />
      )}
    </div>
  );
}
