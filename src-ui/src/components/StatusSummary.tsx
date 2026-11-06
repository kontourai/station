import { Badge, type SemanticTone } from '@kontourai/ui/react';
import type { ReactNode } from 'react';
import './StatusSummary.css';

/** Shared hierarchy for a named resource: identity, status, then check metadata. */
export function StatusSummary({
  title,
  headingId,
  badge,
  current,
  target,
  checkedAt,
}: {
  title: ReactNode;
  headingId?: string;
  badge?: { label: string; tone: SemanticTone } | null;
  current?: string | null;
  target?: string | null;
  checkedAt?: number | null;
}) {
  const Title = headingId ? 'h3' : 'p';
  const checked = checkedAt && checkedAt > 0 ? new Date(checkedAt) : null;
  const now = new Date();
  const clock = checked?.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const day =
    checked && checked.toDateString() !== now.toDateString()
      ? checked.toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          ...(checked.getFullYear() !== now.getFullYear()
            ? { year: 'numeric' }
            : {}),
        })
      : null;
  const transition = !!current && !!target && target !== current;
  return (
    <header className="status-summary">
      <div className="status-summary__heading">
        <Title id={headingId} className="status-summary__title">
          {title}
        </Title>
        {badge && (
          <span className="status-summary__badge" role="status">
            <Badge value={badge.label} tone={badge.tone} />
          </span>
        )}
      </div>
      {(current || checked) && (
        <div className="status-summary__facts">
          {current && (
            <p className="status-summary__version">
              <code>{current}</code>
              {transition && (
                <>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> to </span>
                  <code>{target}</code>
                </>
              )}
            </p>
          )}
          {checked && (
            <small className="status-summary__checked">
              <span>Last checked</span>
              <time
                dateTime={checked.toISOString()}
                title={checked.toLocaleString()}
              >
                {day ? `${day}, ${clock}` : clock}
              </time>
            </small>
          )}
        </div>
      )}
    </header>
  );
}
