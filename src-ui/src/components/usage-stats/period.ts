import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import type { EngineUsageCoverage } from './UsageSummaryCards';

/**
 * Period scoping for the usage panel (archive#3093), built on the ONE range
 * derivation that already exists: the server's `?from=&to=` filter over
 * `byDate` plus its `rangeSummary` (routes/operations/analytics.ts). These
 * helpers only compute the window keys and lay the fetched rows out for
 * rendering — they never sum a range themselves.
 *
 * All date keys are UTC calendar dates, because that is how `byDate` keys are
 * written (`new Date(timestamp).toISOString.split('T')[0]` in
 * usage-aggregator-state.ts). "Today" therefore means today in UTC, matching
 * the stored rows exactly rather than inventing a second calendar the store
 * cannot answer for.
 */

export type UsagePeriod = 'today' | '7d' | '30d' | 'all';

export const USAGE_PERIOD_OPTIONS: ReadonlyArray<{
  id: UsagePeriod;
  label: string;
  days: number | null;
}> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'all', label: 'All time', days: null },
];

/** The exact key shape the aggregator writes `byDate` under. */
export function utcDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Inclusive UTC window for a bounded period, `null` for "all". A period of
 * N days covers N distinct UTC dates ending today: `from = today - (N - 1)`,
 * and the server treats both bounds as inclusive (`date >= f && date <= t`).
 */
export function periodRange(
  period: UsagePeriod,
  now: Date = new Date(),
): { from: string; to: string } | null {
  const option = USAGE_PERIOD_OPTIONS.find((entry) => entry.id === period);
  if (!option || option.days === null) return null;
  return {
    from: utcDateKey(new Date(now.getTime() - (option.days - 1) * MS_PER_DAY)),
    to: utcDateKey(now),
  };
}

/**
 * One chart column. `recorded: false` means the store has NO row for this
 * date — "no recorded activity", which is not the same claim as a measured
 * zero (archive#3201's rule applied to days). Renderers may draw both as a
 * baseline tick, but must never label an absent day with a $0.00 that nobody
 * measured.
 */
export interface TrendDay {
  date: string;
  recorded: boolean;
  messages: number;
  cost: number;
}

/**
 * Lay the fetched `byDate` rows onto every UTC date of the inclusive window,
 * marking dates with no row as unrecorded rather than zero. No summing
 * happens here — totals come from the server's `rangeSummary`.
 */
export function buildTrendDays(
  byDate: Record<string, { messages?: number; cost?: number }> | undefined,
  from: string,
  to: string,
): TrendDay[] {
  const days: TrendDay[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return days;
  for (let time = start; time <= end; time += MS_PER_DAY) {
    const date = utcDateKey(new Date(time));
    const row = byDate?.[date];
    days.push(
      row
        ? {
            date,
            recorded: true,
            messages: row.messages ?? 0,
            cost: row.cost ?? 0,
          }
        : { date, recorded: false, messages: 0, cost: 0 },
    );
  }
  return days;
}

/**
 * Which measure the bars encode: cost when any recorded day measured one,
 * otherwise messages (a period of only zero-cost or cost-unmeasured days
 * would render a flat line under a "cost" heading — technically true,
 * practically unreadable). The chart heading names whichever was chosen, so
 * the switch is disclosed rather than silent.
 */
export function trendMetric(days: TrendDay[]): 'cost' | 'messages' {
  return days.some((day) => day.recorded && day.cost > 0) ? 'cost' : 'messages';
}

/**
 * The one sentence that keeps a period sum from reading as a complete one
 * (the `describeCostCoverage` pattern from archive#3245, applied to the date
 * dimension). After archive#3266, engine (orchestration) sessions contribute
 * lifetime totals but deliberately NO `byDate` rows — a whole-session
 * aggregate has no per-day resolution — so every figure derived from daily
 * history undercounts whenever engine traffic exists.
 *
 * Derived, not a label: `engineUsageCoverage` is written only when a rescan
 * actually folded engine sessions into the lifetime totals, which is exactly
 * the population missing from daily history. `null` when there is nothing to
 * disclose — no engine sessions means daily history and lifetime cover the
 * same corpus.
 */
export function describeDailyHistoryGap(
  coverage: EngineUsageCoverage | undefined,
): string | null {
  if (!coverage || coverage.sessions === 0) return null;
  const subject =
    coverage.sessions === 1
      ? '1 engine session is'
      : `${coverage.sessions} engine sessions are`;
  return `${subject} counted in lifetime totals but not in daily history, so period figures cover Station-recorded activity only.`;
}
