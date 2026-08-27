import { Empty, type EmptyProps } from '@kontourai/ui/react';
import type { ReactNode } from 'react';
import './ErrorState.css';

export interface ErrorStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  variant?: EmptyProps['variant'];
  className?: string;
}

/**
 * The warning triangle, byte-for-byte the glyph the shell's own icon set
 * renders (`src-ui/src/components/icons/Glyph.tsx`'s `WarningGlyph`). Inlined
 * rather than imported because that module is shell-internal and the SDK is a
 * published package — this is the visual-primitive disposition from
 * `docs/design/pane-host-contract.md`: inline chrome cannot be shell-rendered
 * into an iframe, so the component (glyph included) ships in the package and
 * both tiers bundle it. If the shell's glyph path ever changes, this copy
 * changes with it — `ErrorState`'s render is pinned by test in both homes.
 */
function WarningGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height="1em"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 16 16"
      width="1em"
    >
      <path d="M8 2 14 13H2L8 2Zm0 4v3.5m0 2h.01" />
    </svg>
  );
}

/**
 * The published error primitive (station#4201, sequencing step 1 of
 * `docs/design/pane-host-contract.md`): Console Kit ships no error primitive,
 * so this wraps `Empty` with a fixed error affordance (icon + retry `action`
 * slot) rather than reinventing layout. Used for genuine failure states (a
 * crash boundary, a 404) — not for "no data yet" (that's plain `Empty`).
 *
 * This is the SAME component the shell has always rendered — it moved here
 * from `src-ui/src/components/state/ErrorState.tsx`, which now re-exports it,
 * so the direction of truth flips (SDK owns, the shell consumes) without any
 * consumer rendering differently. It joined the published set because a pane
 * capability audit (#4200) found the Board receiving it through a host
 * component slot — and components never cross the pane-host contract; a
 * visual primitive is published instead, both runtime tiers import it, the
 * iframe bundles it.
 *
 * `Empty`'s rendered root carries no ARIA role, so `ErrorState` wraps it in
 * a `role="alert"` element itself — matching the shell-wide convention for
 * error surfaces — rather than pushing that responsibility onto every future
 * caller.
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
      className={`error-state${className ? ` ${className}` : ''}`}
    >
      <Empty
        variant={variant}
        icon={
          <span className="error-state__icon" aria-hidden="true">
            <WarningGlyph />
          </span>
        }
        label={title}
        description={description}
        action={action}
      />
    </div>
  );
}
