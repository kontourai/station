import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
} from '../../hooks/useIsMobile';
import type { DockMode } from '../../types';

/**
 * Which regions a sidebar pill may be opened into, and the model call that
 * does it (#2158).
 *
 * SPLIT FROM `pill-region-placement.ts` BY CONSUMER, not by topic. That module
 * answers "what is this pill's pane id", which the chip row needs while it is
 * BUILDING chips — `ProjectSidebarRow` is eager, so that half is entry-chunk
 * weight whatever anyone does. This half is only needed where a placement menu
 * RENDERS, and both of those callers are behind lazy boundaries (the Boards
 * section, and `ProjectLayoutChipMenu`), so keeping it here keeps it out of the
 * chunk every cold load pays for. The eager chip strip asks a cheaper question
 * instead: `useRegionModelOptional() !== null`, "is there a model at all".
 */

/** The empty answer, one array, so a folded device hands back one identity. */
const NO_REGIONS: readonly DockMode[] = [];

/**
 * The regions a pill may be opened into on THIS device, and the model call
 * that does it.
 *
 * Exactly what `availablePlacements` offers: three edges on a fine pointer
 * above 768px, and `['bottom']` on every coarse pointer whatever its width. So
 * a phone gets ONE row, "Open in Bottom", and not none.
 *
 * ## Why this does NOT borrow `DockPlacementControl`'s fold rule
 *
 * That control returns null at `availablePlacements.length <= 1`, and this hook
 * copied the rule until a review took it apart. The control is a CHOOSER — a
 * `menuitemradio` group over where the dock sits — and with one option there is
 * nothing to choose, so it renders nothing. These rows are an ACTION: "put this
 * Layout in a region" is a thing to DO, and it is worth doing when there is one
 * region just as much as when there are three. The model agrees — it accepts
 * `openSurfaceInRegion(id, { region: 'bottom' })` on a folded device and places
 * the pane there — so the copied rule was withholding a capability the runtime
 * had, on the population that most needs it: a phone, where this menu is the
 * only route a Layout has to sit beside Chat, and where the issue's own
 * acceptance says the menu is what the device gets.
 *
 * `regions` is still empty when no region model is mounted, because there is
 * then nothing that could honour the row. The other absent-row rules live
 * elsewhere and are unchanged: an id the grammar refuses
 * ({@link sidebarLayoutPaneId}) and the Session Board chip, which is a route
 * rather than a pane.
 *
 * The order is `availablePlacements`' own — Left, Right, Bottom.
 */
export function useSidebarPillRegions(): {
  regions: readonly DockMode[];
  openInRegion: (surfaceId: string, region: DockMode) => void;
} {
  const model = useRegionModelOptional();
  const available = availablePlacements(useDockSlotDevice());
  return {
    regions: model ? available : NO_REGIONS,
    openInRegion: (surfaceId, region) => {
      model?.openSurfaceInRegion(surfaceId, { region });
    },
  };
}
