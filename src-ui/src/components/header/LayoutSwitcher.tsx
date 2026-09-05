import { useProjectLayoutsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { describeReadFailure, Empty, ErrorState } from '../state';
import './LayoutSwitcher.css';

interface LayoutSwitcherProps {
  projectSlug: string;
  layoutSlug: string;
}

interface LayoutSummary {
  slug: string;
  name: string;
  icon?: string;
}

/** Header dropdown for switching layouts within the current project — makes
 *  layout navigation first-class instead of hiding it behind a sidebar chevron. */
export function LayoutSwitcher({
  projectSlug,
  layoutSlug,
}: LayoutSwitcherProps) {
  const { setLayout } = useNavigation();
  // `= []` on its own makes a failed read indistinguishable from a
  // project with no layouts, so the menu asserted "No layouts" over a read
  // that never answered.
  const {
    data: layouts = [],
    error: layoutsError,
    refetch: refetchLayouts,
  } = useProjectLayoutsQuery(projectSlug) as {
    data?: LayoutSummary[];
    error?: unknown;
    refetch: () => unknown;
  };
  const [open, setOpen] = useState(false);

  const current = layouts.find((l) => l.slug === layoutSlug);
  const label = current?.name ?? layoutSlug;

  return (
    <span className="layout-switcher">
      <button
        type="button"
        className="layout-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch layout"
        onClick={() => setOpen((v) => !v)}
      >
        {current?.icon && (
          <span className="layout-switcher__icon">{current.icon}</span>
        )}
        <span className="layout-switcher__label">{label}</span>
        <span className="layout-switcher__chevron">▾</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            className="layout-switcher__scrim"
            aria-label="Close layout menu"
            onClick={() => setOpen(false)}
          />
          {/* #1552 D4: the shell's one menu primitive. This menu had its own
              6px radius, 4px padding, `6px 10px` rows and accent-tinted active
              row — a fifth vocabulary beside the four the D4 sweep names. */}
          <div className="menu-surface layout-switcher__menu" role="menu">
            {layoutsError ? (
              <ErrorState
                variant="compact"
                title="Unable to load layouts"
                description={describeReadFailure(layoutsError)}
                action={
                  <Button size="sm" onClick={() => void refetchLayouts()}>
                    Retry
                  </Button>
                }
              />
            ) : (
              layouts.length === 0 && (
                <Empty variant="compact" label="No layouts" />
              )
            )}
            {layouts.map((l) => (
              <button
                key={l.slug}
                type="button"
                role="menuitem"
                className="menu-row"
                // The current layout, from the route rather than from a second
                // stored flag — and painted by `.menu-row[aria-current]`'s own
                // rule, so the pressed look and the announced state are one fact.
                {...(l.slug === layoutSlug
                  ? { 'aria-current': 'page' as const }
                  : {})}
                onClick={() => {
                  setOpen(false);
                  if (l.slug !== layoutSlug) setLayout(projectSlug, l.slug);
                }}
              >
                <span className="menu-row__glyph" aria-hidden="true">
                  {l.icon}
                </span>
                {/* No wrapper span: `.layout-switcher__item-label` had no rule of
                    its own even before D4, and `.menu-row`'s flex line lays the
                    text out directly. */}
                {l.name}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
