import { useMemo } from 'react';
import type { DockRegionId } from '../regions/region-model';
import type { RegionPaneContext } from '../regions/region-surface-panes';
import { RegionEmptyChooser } from './RegionEmptyChooser';
import { useDockProject } from './useDockProject';

/**
 * #2154's chooser as the TOOLBAR opens it (#2155): a long press or a
 * right-click on a region's toggle anchors the same `menu` of rows the
 * region's own "+" opens, so "what goes in this region" has one answer and
 * one panel wherever it is reached from.
 *
 * It exists as its own module because the toolbar is in the entry chunk and
 * the chooser is not: this component is what the toolbar's `LazyBoundary`
 * loads, and it carries the dock-project read (`useDockProject`) with it, so
 * neither the chooser's rows nor the pane inventory behind them join the
 * initial download for a panel most sessions never open. The project read
 * has to be on this side of the boundary rather than in the toolbar for the
 * same reason — it reaches the projects queries.
 *
 * Nothing renders while that read is in FLIGHT, which is the rule the "+"
 * applies (`RegionPaneHost`'s `chooserRegion`, #2154 review M3): a
 * projectless context during the read would list Terminal, Diff and Files
 * disabled with a remedy — "choose a project for this dock" — for a state
 * the user may not be in, and then flip them enabled a frame later. The
 * panel arrives with the answer instead. For a dock with no bound project
 * and no route project there is no read to wait for (`useProject` is
 * disabled on the empty slug), so the common case opens immediately.
 */
export function RegionChooserPanel({
  regionId,
  anchor,
  onClose,
}: {
  regionId: DockRegionId;
  /** The toggle's box: the panel hangs under it and flips above if needed. */
  anchor: { right: number; top: number; bottom: number };
  onClose: () => void;
}) {
  const { projectId, projectSlug, pending } = useDockProject();
  const context = useMemo<RegionPaneContext>(
    () => ({ projectId, projectSlug }),
    [projectId, projectSlug],
  );
  if (pending) return null;
  return (
    <RegionEmptyChooser
      regionId={regionId}
      context={context}
      variant="panel"
      anchor={anchor}
      onClose={onClose}
    />
  );
}
