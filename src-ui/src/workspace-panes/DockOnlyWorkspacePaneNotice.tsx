import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { useShowSurface } from '../contexts/useShowSurface';
import { regionSurfaceOfDescriptor } from '../regions/region-surface-panes';

/**
 * What a Project layout shows in place of a pane that lives in the dock
 * (#2465). A layout can still hold one — the pane picker offered the Device
 * pane before it learned `isProjectPlaceableWorkspacePane` — and the layout
 * host refuses the Project-less occurrence. "This pane belongs to a different
 * Project" was the wrong reason: it belongs to no Project, it belongs in the
 * dock. So this says so, and offers the two ways out: open it where it
 * lives, or take it out of this layout.
 *
 * "Open in dock" appears only when a dock region renders the descriptor as a
 * surface; "Remove from layout" only when the host can close the pane (a
 * host's last pane cannot be closed).
 */
export function DockOnlyWorkspacePaneNotice({
  descriptor,
  onRemove,
}: {
  descriptor: Pick<WorkspacePaneDescriptor, 'id' | 'name'>;
  onRemove?: () => void;
}) {
  const showSurface = useShowSurface();
  const surfaceId = regionSurfaceOfDescriptor(descriptor.id);
  return (
    <Empty
      label={`The ${descriptor.name} pane lives in the dock`}
      description="It is not part of any Project, so this layout cannot show it."
      action={
        surfaceId || onRemove ? (
          <>
            {surfaceId ? (
              <Button variant="primary" onClick={() => showSurface(surfaceId)}>
                Open in dock
              </Button>
            ) : null}
            {onRemove ? (
              <Button onClick={onRemove}>Remove from layout</Button>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
