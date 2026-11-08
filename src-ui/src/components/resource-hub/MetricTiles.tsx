import { Metric } from '@kontourai/ui/react';
import './resource-hub.css';

/** A row of headline figures over the published `Metric`. */
export function MetricTiles({
  metrics,
  label,
}: {
  metrics: ReadonlyArray<{ label: string; value: string | number }>;
  label?: string;
}) {
  return (
    <div
      className="metric-tiles"
      {...(label ? { role: 'group', 'aria-label': label } : {})}
    >
      {metrics.map((metric) => (
        <Metric key={metric.label} label={metric.label} value={metric.value} />
      ))}
    </div>
  );
}
