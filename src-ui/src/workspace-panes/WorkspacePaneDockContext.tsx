import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
  WorkspacePaneSuppliableContexts,
} from '@kontourai/station-contracts/workspace-pane';
import { createContext, useContext } from 'react';

/**
 * The ambient shell slot is the only host that can replace its occupant.
 * Keeping that authority in context makes an offered dock action truthful:
 * renderers outside that host receive no action instead of dispatching a
 * request that nobody can answer.
 */
export interface WorkspacePaneDockAction {
  /**
   * What the providing host can supply to an occupant. The HOST declares this
   * (it is the one that knows its scope); the action only intersects it with
   * a pane's modes. Two reasons it lives here rather than being derived at
   * the action:
   *
   * 1. The action must not assume WHICH host it would dock into — a second
   *    host with a different scope provides a different set through the same
   *    context, and the action stays correct unchanged.
   * 2. Deriving it at the action imported the host-contract module into the
   *    ENTRY chunk through this always-mounted control: measured +2,308 gzip
   *    bytes, the whole module, for one ten-line function. The host already
   *    lives in the lazy chunk; the derivation belongs where the host is.
   */
  suppliable: WorkspacePaneSuppliableContexts;
  dockPane(
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ): void;
  /**
   * `dockPane`, plus the mobile dock-and-empty contract (station#520,
   * archive#4471).
   *
   * THE CONTRACT: at phone width, a dock action that would leave the main
   * area with no meaningful content auto-maximizes the docked pane instead
   * — the composition "placeholder card (`WorkspacePaneAwayState`) as the
   * only viewport content" is refused by construction, never detected and
   * patched up after the fact.
   *
   * THE DERIVATION SHIPPED: deciding "would leave no meaningful content"
   * honestly needs the current route's composition (does it have other
   * content besides this pane?), which the ambient dock host cannot see —
   * it is occupant-agnostic infrastructure with no `pathname`/
   * `NavigationView`. The fallback this method encodes: call it ONLY from
   * the exact place a pane's own content offers to dock itself
   * (`WorkspacePaneDockAction`, "Dock this pane") — every call arriving
   * there is, by construction, "dock the pane the main viewport currently,
   * entirely renders", because the button is part of that pane's own
   * rendered output. On mobile, `dockPaneAsOnlyContent` opens the dock
   * MAXIMIZED rather than preserving whatever snap it already had, so the
   * dock itself covers the screen instead of leaving a collapsed/half bar
   * over an otherwise-empty main area.
   *
   * DISCLOSED GAP: `DockOccupantPicker`'s occupant switch is a different
   * call site (chosen from the dock's own chrome, not from route content)
   * and stays on plain `dockPane` — picking an occupant whose route happens
   * to already be the main view can still reproduce the empty composition.
   * Not derived away; a real remaining gap.
   */
  dockPaneAsOnlyContent(
    descriptor: WorkspacePaneDescriptor,
    instance: WorkspacePaneInstance,
  ): void;
  /**
   * The `instanceId` of the providing host's CURRENT occupant — republished
   * from the host's own document state on every occupant change, so a route
   * placement derives "my pane is away in the dock" from the same source of
   * truth the dock renders from (archive#4090). Never a second store or a
   * parallel flag: the host's `onDocumentChange` is the only writer.
   */
  occupantInstanceId: string;
  /**
   * Removes the current occupant from the providing host's slot, restoring
   * its baseline occupant (Chat, today's semantic — the ambient document's
   * own baseline). Implemented by the host so a route's away state can offer
   * "Bring it back here" without importing the baseline pane's machinery
   * into its chunk.
   */
  undockOccupant(): void;
}

/**
 * The one derivation of "this pane's canonical occurrence is the dock's
 * occupant", shared by every route placement that renders an away state —
 * never re-derived per view (one derivation per fact). Null action means no
 * host is publishing (the dock is absent), which can never read as "away".
 */
export function isAmbientDockOccupant(
  action: WorkspacePaneDockAction | null,
  instance: WorkspacePaneInstance,
): boolean {
  return action !== null && action.occupantInstanceId === instance.instanceId;
}

export const WorkspacePaneDockContext =
  createContext<WorkspacePaneDockAction | null>(null);

export function useWorkspacePaneDockAction(): WorkspacePaneDockAction | null {
  return useContext(WorkspacePaneDockContext);
}
