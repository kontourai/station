import { resolveRegionSurface } from '../../regions/region-model';

/**
 * Which Layout a sidebar pill names as a dock pane (#2158). Its companion
 * `pill-region-open.ts` answers where one may go; the split is by consumer and
 * that file records why.
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
