import {
  ChartGlyph,
  FolderGlyph,
  MessageGlyph,
  MoneyGlyph,
} from '../icons/Glyph';
import { StatCard } from './StatCard';

/**
 * How many engine sessions the lifetime cost was actually measured across
 * (archive#3245). Absent when this deployment has no engine sessions to
 * describe.
 */
export interface EngineUsageCoverage {
  sessions: number;
  sessionsReportingTokens: number;
  sessionsReportingCost: number;
}

/**
 * The one sentence that keeps a partial sum from reading as a complete one.
 *
 * A lifetime cost is summed over the sessions that reported a cost; the rest
 * contributed nothing rather than a zero (archive#3201's rule, applied to a
 * sum). Saying so is the difference between "$0.25 spent" and "$0.25 spent,
 * and four of the five engines you ran never told us what they charged".
 *
 * `null` — no caption — in exactly the two cases where there is nothing to
 * disclose: no engine sessions at all (every figure is Station's own
 * accounting), or every engine session reported a cost.
 */
export function describeCostCoverage(
  coverage: EngineUsageCoverage | undefined,
): string | null {
  if (!coverage || coverage.sessions === 0) return null;
  if (coverage.sessionsReportingCost === coverage.sessions) return null;
  if (coverage.sessionsReportingCost === 0) {
    return coverage.sessions === 1
      ? 'The 1 engine session in this total reported no cost.'
      : `None of the ${coverage.sessions} engine sessions in this total reported a cost.`;
  }
  return `Measured on ${coverage.sessionsReportingCost} of ${coverage.sessions} engine sessions; the rest reported no cost.`;
}

export function UsageSummaryCards({
  avgCostPerMessage,
  engineUsageCoverage,
  totalConversations,
  totalCost,
  totalMessages,
}: {
  avgCostPerMessage: number;
  engineUsageCoverage?: EngineUsageCoverage;
  totalConversations: number;
  totalCost: number;
  totalMessages: number;
}) {
  const costCoverage = describeCostCoverage(engineUsageCoverage);
  return (
    <div className="usage-stats-cards">
      <StatCard
        icon={<MessageGlyph />}
        label="Messages"
        value={totalMessages.toLocaleString()}
        color="var(--accent-primary)"
      />
      <StatCard
        icon={<FolderGlyph />}
        label="Conversations"
        value={totalConversations.toLocaleString()}
      />
      <StatCard
        icon={<MoneyGlyph />}
        label="Total Cost"
        value={`$${totalCost.toFixed(2)}`}
        detail={costCoverage}
      />
      <StatCard
        icon={<ChartGlyph />}
        label="Avg/Message"
        value={`$${avgCostPerMessage.toFixed(4)}`}
        detail={costCoverage ? 'Over the measured cost above.' : undefined}
      />
    </div>
  );
}
