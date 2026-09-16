import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  dockFoldsToOneRegion,
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

/** The empty answer, one frozen array, so a folded device re-renders nothing. */
const NO_REGIONS: readonly DockMode[] = Object.freeze([]);

/**
 * The regions a pill may be opened into on THIS device, and the model call
 * that does it.
 *
 * `regions` is empty — so the caller renders no placement rows at all — when
 * the device folds the dock to one region (a coarse pointer or a narrow
 * viewport: `availablePlacements`), which is `DockPlacementControl`'s existing
 * rule for the same question (#2158 D4), and when no region model is mounted,
 * because there is then nothing that could honour the row.
 *
 * The order is `availablePlacements`' own — Left, Right, Bottom — which is the
 * order `DockPlacementControl` already renders the same three edges in.
 */
export function useSidebarPillRegions(): {
  regions: readonly DockMode[];
  openInRegion: (surfaceId: string, region: DockMode) => void;
} {
  const model = useRegionModelOptional();
  const available = availablePlacements(useDockSlotDevice());
  return {
    regions: model && !dockFoldsToOneRegion(available) ? available : NO_REGIONS,
    openInRegion: (surfaceId, region) => {
      model?.openSurfaceInRegion(surfaceId, { region });
    },
  };
}
