import type { CSSProperties } from 'react';
import { type TrendDay, trendMetric } from './period';

/**
 * Daily bars over the selected window (archive#3093) — hand-rolled CSS bars
 * in the repo's own style (see `views/home/blocks/activity-bars.tsx`), no
 * charting dependency.
 *
 * Honesty rules it renders under:
 * - A date with no stored row is "No activity recorded" — its tick carries
 *   that label, never a fabricated `$0.00 · 0 messages` (archive#3201's
 *   unreported-vs-zero rule applied to days).
 * - A recorded day's tooltip states both measures the row actually holds,
 *   including an honest measured `$0.00`.
 * - The heading names the measure the bars encode (`trendMetric`), so a
 *   messages-fallback period is disclosed, not silently relabeled.
 */

function dayLabel(date: string): string {
  // Local-noon parse renders the UTC date key as written without the
  // off-by-one a midnight parse gives negative-offset timezones — the same
  // trick ActivityTimeline and ProfilePage already use.
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Bar height as a fraction of the window's tallest recorded value, floored
 * (like `activity-bars`' barHeight) so a day with activity never renders as
 * an empty one. Zero stays zero: a measured $0.00 day is a baseline stub
 * whose label — not its height — distinguishes it from an unrecorded day.
 */
export function trendBarFraction(value: number, peak: number): number {
  if (value <= 0) return 0;
  return Math.max(0.18, value / Math.max(peak, Number.EPSILON));
}

export function trendDayTitle(day: TrendDay): string {
  if (!day.recorded) return `${dayLabel(day.date)} — No activity recorded`;
  return `${dayLabel(day.date)} — $${day.cost.toFixed(4)} · ${day.messages} message${
    day.messages === 1 ? '' : 's'
  }`;
}

export function UsageTrendChart({ days }: { days: TrendDay[] }) {
  if (days.length === 0) return null;
  const metric = trendMetric(days);
  const peak = Math.max(
    0,
    ...days.map((day) => (metric === 'cost' ? day.cost : day.messages)),
  );
  const recordedCount = days.filter((day) => day.recorded).length;
  return (
    <div className="usage-trend">
      <div className="usage-trend__header">
        <span className="usage-trend__title">
          {metric === 'cost' ? 'Daily cost' : 'Daily messages'}
        </span>
        {metric === 'messages' && (
          <span className="usage-trend__note">
            No cost recorded in this period; bars show messages.
          </span>
        )}
      </div>
      <div
        className="usage-trend__bars"
        role="img"
        aria-label={`Daily ${metric} bars, ${days.length} days, ${recordedCount} with recorded activity`}
      >
        {days.map((day) => (
          <span
            key={day.date}
            className={`usage-trend__bar${day.recorded ? '' : ' usage-trend__bar--empty'}`}
            style={
              day.recorded
                ? ({
                    '--bar': trendBarFraction(
                      metric === 'cost' ? day.cost : day.messages,
                      peak,
                    ),
                  } as CSSProperties)
                : undefined
            }
            title={trendDayTitle(day)}
          />
        ))}
      </div>
      <div className="usage-trend__axis" aria-hidden="true">
        <span>{dayLabel(days[0].date)}</span>
        {days.length > 1 && <span>{dayLabel(days[days.length - 1].date)}</span>}
      </div>
    </div>
  );
}
