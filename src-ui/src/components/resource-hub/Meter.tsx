import type { ReactNode } from 'react';
import './resource-hub.css';

const percentFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

/** "26.8", or "<0.1" for a sliver the formatter would round to zero. */
export function remainingPercentText(usedPercent: number): string {
  const remaining = 100 - usedPercent;
  return remaining > 0 && remaining < 0.1
    ? '<0.1'
    : percentFormatter.format(remaining);
}

/**
 * How much of an allowance is left, as text first. An unreported reading
 * draws no bar: an empty `<meter>` reads as 0%, and unknown is not empty.
 */
export function Meter({
  label,
  usedPercent,
  children,
}: {
  label: string;
  /** What the provider reports as used; `undefined` when it did not. */
  usedPercent: number | undefined;
  /** Reset time, scope and availability lines under the bar. */
  children?: ReactNode;
}) {
  const left =
    usedPercent === undefined ? undefined : remainingPercentText(usedPercent);
  return (
    <div className="resource-meter">
      <div className="resource-meter__heading">
        <span>{label}</span>
        <strong>{left === undefined ? 'Not reported' : `${left}% left`}</strong>
      </div>
      {usedPercent !== undefined && (
        <meter
          min={0}
          max={100}
          value={100 - usedPercent}
          aria-label={`${label}: ${left}% remaining`}
        />
      )}
      {children}
    </div>
  );
}
