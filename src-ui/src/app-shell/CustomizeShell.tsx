import type { MouseEvent, ReactNode } from 'react';
import { LazyBoundary } from '../components/LazyBoundary';
import { navigationStore } from '../contexts/navigation-store';
import { useIsMobile } from '../hooks/useIsMobile';
import './customize-shell.css';

// Lazy: the list reads every item's data, which first paint of any other
// route does not need.
const loadCustomizeNav = () =>
  import('../views/customize/CustomizeNav').then((module) => ({
    default: module.CustomizeNav,
  }));

const CUSTOMIZE_NAV_SURFACE = { id: 'customize-nav', label: 'Customize' };

/**
 * The Customize page: its left list beside the routed page. The list
 * stays mounted while moving between items, so it does not reload or lose
 * its scroll on each click.
 *
 * Every route renders inside it, at the same place in the tree, so moving
 * between a Customize item and any other page keeps the departing page
 * mounted (held by the route's Suspense) while the arriving one loads. Off a
 * Customize item (`activeId` null) it draws no list and takes no box of its
 * own (`display: contents`), so the page lays out as if it were not there.
 */
export function CustomizeShell({
  activeId,
  fill,
  children,
}: {
  /** The Customize item the routed page belongs to, or null for any other page. */
  activeId: string | null;
  /** The routed page fills the height and scrolls inside itself. */
  fill: boolean;
  children: ReactNode;
}) {
  // On a phone the landing's list is the way in, so the left list is not
  // rendered (or loaded) there at all.
  const isMobile = useIsMobile();
  const className = [
    'customize-shell',
    activeId === null ? 'customize-shell--off' : null,
    fill ? 'customize-shell--fill' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={className}>
      {activeId === null || isMobile ? null : (
        <div className="customize-shell__nav">
          <LazyBoundary
            load={loadCustomizeNav}
            componentProps={{ activeId }}
            surface={CUSTOMIZE_NAV_SURFACE}
            pending={null}
            shareAcrossMounts
          />
        </div>
      )}
      <div className="customize-shell__main">{children}</div>
    </div>
  );
}

/**
 * The way back to the Customize landing from an item. On a phone the list is
 * hidden, so this eyebrow is the only way back from an item without the
 * drawer. A view that publishes its own eyebrow replaces it.
 */
function CustomizeEyebrow() {
  return (
    <a
      href="/customize"
      className="page__label-link"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        navigationStore.navigate('/customize');
      }}
    >
      Customize
    </a>
  );
}

/** Every Customize item's page frame names this eyebrow (`page-frame-registry`). */
export const CUSTOMIZE_EYEBROW = <CustomizeEyebrow />;
