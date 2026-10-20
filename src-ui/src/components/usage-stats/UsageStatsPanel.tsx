import type { UsageStats } from '@kontourai/station-contracts/usage-stats';
import { useActivityUsageQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
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
import { getTotalUsageConversations } from './utils';
import './UsageStatsPanel.css';

type DrillDownType = 'model' | 'agent' | null;

/**
 * The period-scoped half of the panel (archive#3093): summary figures from
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
    data.snapshot,
    data.unallocated?.date,
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

  const datedUsage: UsageStats['byDate'] = data.byDate ?? {};
  const costMeasured =
    data.snapshot?.projection !== 'retained-source-v1' ||
    Object.values(datedUsage).some(
      (day) =>
        day.reportedCostUsd !== undefined || day.estimatedCostUsd !== undefined,
    );
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
          label="Recorded cost"
          value={
            costMeasured
              ? `$${rangeSummary.totalCost.toFixed(2)}`
              : 'Not reported'
          }
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
  const { usageStats, loading, error, refresh } = useAnalytics();
  const models = useModels();
  const agents = useAgents();
  const [drillDown, setDrillDown] = useState<{
    type: DrillDownType;
    id: string;
  } | null>(null);
  // Default "all" keeps the panel's first render the complete lifetime
  // accounting (the only view that includes engine sessions); the bounded
  // views are one tap away.
  const [period, setPeriod] = useState<UsagePeriod>('all');
  const range = periodRange(period);

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
  const totalConversations = getTotalUsageConversations(lifetime);

  return (
    <div className="usage-stats-panel">
      <div className="usage-stats-header">
        <h3 className="usage-stats-title">
          <span>
            <ChartGlyph />
          </span>
          <span>Usage</span>
        </h3>
      </div>

      {usageStats?.snapshot?.projection !== 'retained-source-v1' && (
        <p className="usage-period-note">Older summary · rebuild to refresh.</p>
      )}
      <UsagePeriodSelector value={period} onChange={setPeriod} />

      {range ? (
        <UsagePeriodSection from={range.from} to={range.to} />
      ) : (
        <UsageSummaryCards
          daysActive={lifetime.daysActive}
          engineUsageCoverage={lifetime.engineUsageCoverage}
          totalConversations={totalConversations}
          totalCost={lifetime.totalCost}
          totalMessages={lifetime.totalMessages}
          costMeasured={
            usageStats.snapshot?.projection !== 'retained-source-v1' ||
            lifetime.reportedCostUsd !== undefined ||
            lifetime.estimatedCostUsd !== undefined
          }
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
            Model and agent breakdowns · all time
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
        unallocatedModelMessages={usageStats.unallocated?.model.messages}
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
