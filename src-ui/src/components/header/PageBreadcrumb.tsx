import { Fragment } from 'react';
import './PageBreadcrumb.css';

export interface PageBreadcrumbSegment {
  label: string;
  /** When set (and not the last segment), the crumb is a clickable "up" link. */
  onClick?: () => void;
}

/**
 * A monospace, eyebrow-style breadcrumb for page headers — gives deep views
 * (e.g. an agent's Tools editor) a clear "Agents / my-agent / Tools" path with
 * clickable ancestors. They are real buttons so keyboard and pointer callers
 * cross the same interface without changing the established visual treatment.
 */
export function PageBreadcrumb({
  segments,
}: {
  segments: PageBreadcrumbSegment[];
}) {
  return (
    <nav className="page-breadcrumb" aria-label="Breadcrumb">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={`${seg.label}-${i}`}>
            {seg.onClick && !isLast ? (
              <button
                type="button"
                className="page-breadcrumb__link"
                onClick={seg.onClick}
              >
                {seg.label}
              </button>
            ) : (
              <span
                className="page-breadcrumb__current"
                aria-current={isLast ? 'page' : undefined}
              >
                {seg.label}
              </span>
            )}
            {!isLast && <span className="page-breadcrumb__sep">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
