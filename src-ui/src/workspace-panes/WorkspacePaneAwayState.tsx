import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { useWorkspacePaneDockAction } from './WorkspacePaneDockContext';

/**
 * The route's away state while its pane occupies the ambient dock
 * (archive#4090). Before this, a route whose pane was docked rendered it
 * AGAIN — two live co-mounted placements of one occurrence ( disclosed
 * behavior). The away state is honest chrome riding the shared `Empty`
 * primitive: the pane's name, where it is, and one action that removes it
 * from the dock (restoring the dock's baseline occupant, Chat) so the route
 * renders its pane again.
 *
 * Rendered only when the caller derived "away" through
 * `isAmbientDockOccupant` — the same published host state the dock renders
 * from — so this component offers the action only if a host is actually
 * publishing one.
 */
export function WorkspacePaneAwayState({ paneName }: { paneName: string }) {
  const dock = useWorkspacePaneDockAction();
  if (!dock) return null;
  return (
    <Empty
      label={`${paneName} is in the dock`}
      description="This pane is currently docked at the edge of your workspace."
      action={<Button onClick={dock.undockOccupant}>Bring it back here</Button>}
    />
  );
}
