import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
} from '../../hooks/useIsMobile';
import { resolveRegionSurface } from '../../regions/region-model';
import type { DockMode } from '../../types';

/**
 * The half of #2158 both sidebar pills share: which Layout a pill names as a
 * dock pane, and which regions it may be opened into.
 *
 * ## Why this builds the id instead of calling the contract
 *
 * `workspaceLayoutPaneId` (`packages/contracts/src/workspace-layout-pane.ts`)
 * is the minter, and it is the wrong import HERE. Reaching the pane contracts
 * from the sidebar is what `useOpenInRegion.ts` costs — its own docblock
 * records +1,820 B gzip against a 527 B headroom, which is why every caller of
 * `openLayoutInRegion` sits behind a lazy boundary. The sidebar does not: it is
 * `main.tsx` → `App.tsx` → `ProjectSidebar`, statically, in the entry chunk.
 *
 * So the id is a string built here and handed to
 * `RegionModelContext.openSurfaceInRegion`, which is already in that chunk and
 * resolves both prefixes itself. The ONLY duplication that leaves is the id's
 * spelling, and `pill-region-placement.test.ts` pins it against the contract's
 * minter for both families and for the ids the grammar refuses.
 *
 * ## The grammar is not re-implemented either
 *
 * `resolveRegionSurface` is the entry chunk's own id-keyed admission, and its
 * `INSTANCE_SURFACE_PREFIXES` table already carries the exact lowercase-UUID
 * shapes `workspaceLayoutPaneId` mints (`region-model.ts`, #2157). Asking IT
 * whether the built id is a surface is one grammar, not a second copy — and it
 * is the same gate `openSurfaceInRegion` applies, so a row this admits is a row
 * that cannot be refused for its id when pressed.
 */
export type SidebarLayoutPaneKey =
  | { kind: 'board'; layoutId: string }
  | { kind: 'project'; projectId: string; layoutId: string };

/**
 * The pane id for one Board or project Layout, or null when a part is not a
 * lowercase UUID — a pre-provisioned project's hand-written id, or a record
 * from before the server minted them.
 *
 * Null means the pill offers NO placement row (#2158 D2). A row that rendered
 * and then refused would be a control whose failure the user meets only after
 * pressing it; an absent row is the same fact stated before the press.
 */
export function sidebarLayoutPaneId(key: SidebarLayoutPaneKey): string | null {
  const id =
    key.kind === 'board'
      ? `board:${key.layoutId}`
      : `layout:${key.projectId}/${key.layoutId}`;
  return resolveRegionSurface(id) ? id : null;
}

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
