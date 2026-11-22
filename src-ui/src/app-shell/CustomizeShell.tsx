import { lazy, type ReactNode, Suspense } from 'react';
import './customize-shell.css';

// Lazy: the list reads every item's data, which first paint of any other
// route does not need.
const CustomizeNav = lazy(() =>
  import('../views/customize/CustomizeNav').then((module) => ({
    default: module.CustomizeNav,
  })),
);

/**
 * The Customize page: its left list beside the routed page. The list
 * stays mounted while moving between items, so it does not reload or lose
 * its scroll on each click.
 */
export function CustomizeShell({
  activeId,
  fill,
  children,
}: {
  activeId: string;
  /** The routed page fills the height and scrolls inside itself. */
  fill: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`customize-shell${fill ? ' customize-shell--fill' : ''}`}>
      <div className="customize-shell__nav">
        <Suspense fallback={null}>
          <CustomizeNav activeId={activeId} />
        </Suspense>
      </div>
      <div className="customize-shell__main">{children}</div>
    </div>
  );
}
