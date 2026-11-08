import './resource-hub.css';

export interface DailyBar {
  /** `YYYY-MM-DD`. */
  day: string;
  /** `undefined`: nothing was reported that day, drawn distinct from zero. */
  value: number | undefined;
  /** The value as the reader should see it ("$2.00", "1,200"). */
  valueLabel?: string;
}

/**
 * One bar per day. An unreported day keeps its slot with a muted stub and
 * says "Not reported", so a gap never reads as a quiet day.
 */
export function DailyBars({
  bars,
  caption,
  unit,
  label,
}: {
  bars: readonly DailyBar[];
  caption: string;
  /** Shown under the caption, such as a currency. */
  unit?: string;
  /** The chart's accessible name. */
  label: string;
}) {
  const peak = Math.max(...bars.map((bar) => bar.value ?? 0), 1);
  return (
    <figure className="daily-bars">
      <figcaption>{caption}</figcaption>
      {unit && <small>{unit}</small>}
      <div className="daily-bars__chart" role="img" aria-label={label}>
        {bars.map((bar) => (
          <span
            key={bar.day}
            title={`${bar.day}: ${bar.value === undefined ? 'Not reported' : (bar.valueLabel ?? bar.value.toLocaleString())}`}
            data-unreported={bar.value === undefined || undefined}
            style={{
              height: `${Math.max(2, ((bar.value ?? 0) / peak) * 100)}%`,
            }}
          />
        ))}
      </div>
      {bars.length > 0 && (
        <div className="daily-bars__axis">
          <span>{bars[0]!.day}</span>
          <span>{bars.at(-1)!.day}</span>
        </div>
      )}
    </figure>
  );
}
