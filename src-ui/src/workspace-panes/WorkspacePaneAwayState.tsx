import { Button } from '../components/Button';
import { Empty } from '../components/state';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWorkspacePaneDockAction } from './WorkspacePaneDockContext';

/**
 * The route's away state while its pane occupies another shell placement
 * (archive#4090, #928). Before this, a route whose pane was docked rendered
 * it AGAIN — two live co-mounted placements of one occurrence. The away
 * state names where the pane is; the legacy ambient placement also offers
 * its host-owned action to return the pane to the route.
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
export function WorkspacePaneAwayState({
  paneName,
  regionName,
  regionVisible = true,
  onShowPane,
}: {
  paneName: string;
  regionName?: string;
  regionVisible?: boolean;
  onShowPane?: () => void;
}) {
  const dock = useWorkspacePaneDockAction();
  const isMobile = useIsMobile();
  if (!dock && !regionName) return null;
  const location = regionName ?? (isMobile ? 'the bottom bar' : 'the dock');
  const hiddenRegion = Boolean(regionName && !regionVisible);
  return (
    <Empty
      label={
        hiddenRegion
          ? `${paneName} is hidden from ${location}`
          : `${paneName} is in ${location}`
      }
      description={
        regionName
          ? hiddenRegion
            ? `This pane is assigned to ${location.toLowerCase()} but is not currently shown.`
            : `This pane is currently open in ${location.toLowerCase()}.`
          : isMobile
            ? 'This pane is currently docked in the bottom bar.'
            : 'This pane is currently docked at the edge of your workspace.'
      }
      action={
        hiddenRegion && onShowPane ? (
          <Button onClick={onShowPane}>Show {paneName}</Button>
        ) : dock && !regionName ? (
          <Button onClick={dock.undockOccupant}>Bring it back here</Button>
        ) : undefined
      }
    />
  );
}
