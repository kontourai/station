import { useState } from 'react';
import './resource-hub.css';

export interface DailyBar {
  /** `YYYY-MM-DD`. */
  day: string;
  /** `undefined`: nothing was reported that day, drawn distinct from zero. */
  value: number | undefined;
  /** The value as the reader should see it ("$2.00", "1,200"). */
  valueLabel?: string;
}

function barText(bar: DailyBar): string {
  return bar.value === undefined
    ? 'Not reported'
    : (bar.valueLabel ?? bar.value.toLocaleString());
}

/**
 * One bar per day, with the same values as a table behind a disclosure. An
 * unreported day keeps its slot as a dashed outline and says "Not reported",
 * so a gap never reads as a quiet day; a reported zero is a thin solid stub.
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
  // Rendered only while open, like the allowance history's table.
  const [tableOpen, setTableOpen] = useState(false);
  const peak = Math.max(...bars.map((bar) => bar.value ?? 0), 1);
  return (
    <figure className="daily-bars">
      <figcaption>{caption}</figcaption>
      {unit && <small>{unit}</small>}
      <div className="daily-bars__chart" role="img" aria-label={label}>
        {bars.map((bar) => (
          <span
            key={bar.day}
            title={`${bar.day}: ${barText(bar)}`}
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
      {bars.length > 0 && (
        <details
          className="daily-bars__details"
          onToggle={(event) => setTableOpen(event.currentTarget.open)}
        >
          <summary>View daily values</summary>
          {tableOpen && (
          <div className="daily-bars__table">
            <table>
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">{unit ? `Value (${unit})` : 'Value'}</th>
                </tr>
              </thead>
              <tbody>
                {bars.map((bar) => (
                  <tr key={bar.day}>
                    <td>{bar.day}</td>
                    <td>{barText(bar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </details>
      )}
    </figure>
  );
}
