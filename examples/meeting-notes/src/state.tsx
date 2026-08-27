/**
 * Plugin-local canonical Empty/ErrorState/Skeleton family (CLAUDE.md "State
 * primitives" — every empty/loading/error state renders through one
 * canonical family, not bespoke per-view markup).
 *
 * Station's own canonical family lives at `src-ui/src/components/state/`,
 * but that module is internal to the Station app bundle and is not
 * resolvable across the plugin boundary (plugins only ever depend on
 * `@kontourai/station-sdk` + React, never `src-ui/*`). This module mirrors
 * that family's exact shape one layer down: `Empty`/`Skeleton` are
 * re-exported directly from Console Kit (`@kontourai/ui/react` — already a
 * monorepo dependency used by `src-ui` itself, not a new/heavy one this
 * plugin introduces), and `ErrorState` wraps `Empty` with the same fixed
 * error affordance `src-ui`'s `ErrorState` uses, rather than inventing new
 * bespoke markup.
 */
import {
  Empty,
  type EmptyProps,
  Skeleton,
  type SkeletonProps,
} from '@kontourai/ui/react';
import type { ReactNode } from 'react';

export type { EmptyProps, SkeletonProps };
export { Empty, Skeleton };

export interface ErrorStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  variant?: EmptyProps['variant'];
  className?: string;
}

/**
 * Genuine failure states (a 404, a request that threw) — not "no data yet"
 * (use `Empty` directly for that).
 */
export function ErrorState({
  title,
  description,
  action,
  variant = 'prominent',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`mn-error-state${className ? ` ${className}` : ''}`}
    >
      <Empty
        variant={variant}
        icon={
          <span className="mn-error-state__icon" aria-hidden="true">
            ⚠
          </span>
        }
        label={title}
        description={description}
        action={action}
      />
    </div>
  );
}
