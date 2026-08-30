import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { useIsMobile } from '../hooks/useIsMobile';
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
 *
 * station#520 (mobile dock-and-empty contract, part 2): the copy is
 * posture-aware. "Docked at the edge of your workspace" describes the
 * desktop side/bottom-panel dock; on mobile every dock is a bottom bar
 * (`useIsMobile`'s own doc, `index.css`'s "every mobile dock is a bottom
 * sheet"), so the phone reading names that instead. This card is now only
 * reachable when the main area genuinely has OTHER content beside it — see
 * `dockPaneAsOnlyContent` on `WorkspacePaneDockAction` (the interface) for
 * the refusal that keeps a phone from rendering this as the viewport's only
 * content in the first place.
 */
export function WorkspacePaneAwayState({ paneName }: { paneName: string }) {
  const dock = useWorkspacePaneDockAction();
  // Compatibility action for the route-owned away surface. // #928 step 5
  const isMobile = useIsMobile();
  if (!dock) return null;
  return (
    <Empty
      label={`${paneName} is in ${isMobile ? 'the bottom bar' : 'the dock'}`}
      description={
        isMobile
          ? 'This pane is currently docked in the bottom bar.'
          : 'This pane is currently docked at the edge of your workspace.'
      }
      action={<Button onClick={dock.undockOccupant}>Bring it back here</Button>}
    />
  );
}
