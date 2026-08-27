import { Skeleton } from '@kontourai/ui/react';
import './Skeleton.css';

// The single-block placeholder is the shared @kontourai/ui primitive; re-export
// it so existing Station imports keep working.
export { Skeleton, type SkeletonProps } from '@kontourai/ui/react';

export interface SkeletonListProps {
  count?: number;
  withIcon?: boolean;
  label?: string;
}

export interface SkeletonBlockProps {
  /** Number of stacked block placeholders. */
  count?: number;
  label?: string;
  className?: string;
}

/**
 * Stacked block placeholders for a region that is not a list — a page body, a
 * settings section, a stat panel.
 *
 * `SkeletonList` mirrors a row rhythm; this mirrors a prose/card region, and
 * the two together are the whole loading vocabulary (SHELL-13 counted eleven
 * treatments in the shipped app, nine of them one-off strings). A view that
 * needs to say "waiting" reaches for one of these, never for a new sentence:
 * a bespoke "Loading X..." string is untranslatable, unstyled, holds no
 * layout, and — measured across the 28 routes — never agrees with its
 * neighbours on casing, ellipsis or noun.
 */
export function SkeletonBlock({
  count = 3,
  label = 'Loading',
  className,
}: SkeletonBlockProps) {
  return (
    <div
      className={`skeleton-block${className ? ` ${className}` : ''}`}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, i) => (
        // Static placeholder blocks: index keys are correct (order never changes).
        <Skeleton variant="block" key={i} />
      ))}
    </div>
  );
}

/**
 * Placeholder rows that mirror SplitPaneLayout's list items, so the list panel
 * keeps its shape while items load (used by 10+ views via SplitPaneLayout).
 * Station-specific layout on top of the shared <Skeleton>.
 */
export function SkeletonList({
  count = 6,
  withIcon = true,
  label = 'Loading',
}: SkeletonListProps) {
  return (
    <div
      className="skeleton-list"
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {Array.from({ length: count }, (_, i) => (
        // Static placeholder rows: index keys are correct (order never changes).
        <div className="skeleton-list__item" key={i}>
          {withIcon && (
            <Skeleton variant="circle" className="skeleton-list__icon" />
          )}
          <div className="skeleton-list__text">
            <Skeleton variant="line" className="skeleton-list__name" />
            <Skeleton variant="line" className="skeleton-list__sub" />
          </div>
        </div>
      ))}
    </div>
  );
}
