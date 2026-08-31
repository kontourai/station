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
  // Compatibility placement API retained while Workspace Panes migrate to
  // shell-owned region commands. // #928 step 4
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
   * THE DERIVATION: deciding "would leave no meaningful content" honestly
   * needs the current route's composition — does it have other content
   * besides this pane? — which nothing here derives crisply for every
   * caller. What IS derived, from two call sites, each with what it can
   * honestly know:
   *
   * - `WorkspacePaneDockAction` ("Dock this pane") is rendered BY the pane's
   *   own content, so every call through it is, by construction, "dock the
   *   pane the main viewport currently, entirely renders" — no route lookup
   *   needed, the caller already IS that content. THE ENFORCEMENT BOUNDARY
   *   (review round 2, M4): that "by construction" holds only because every
   *   render site of `WorkspacePaneDockAction` today is a full-viewport pane
   *   host (`HomeWorkspacePane`, `ActivityWorkspacePane`) — a future
   *   multi-pane placement (e.g. two panes side by side) would render the
   *   SAME action while genuinely not being the viewport's only content,
   *   and nothing here would stop it from inheriting this method's
   *   maximize-on-mobile behavior anyway.
   * - `DockOccupantPicker`'s onChoose seam is a REAL React component (not
   *   occupant-agnostic infrastructure), so it reads `useNavigation()` and
   *   `resolveViewFromPath` directly and calls this method exactly when the
   *   PICKED pane's own canonical route (`ambientDockOccupantRouteViewType`)
   *   is the route already on screen (`shouldMaximizeOnOccupantChoice`) —
   *   picking Home from the picker while standing on `/` reproduces the
   *   same stranding "Dock this pane" refuses, and now refuses it too.
   *
   * Both paths open the dock MAXIMIZED on mobile rather than preserving
   * whatever snap it already had, so the dock itself covers the screen
   * instead of leaving a collapsed/half bar over an otherwise-empty main
   * area.
   *
   * KNOWN REMAINING SCOPE (a choice, not an inability): this covers "the
   * picked/docked pane's OWN route is the current route" — a route-identity
   * match, not full route-composition awareness. A route whose main view is
   * something else entirely but which ALSO happens to render nothing of
   * substance (an edge case neither call site can see) is out of scope by
   * the same reasoning `WorkspacePaneDockAction`'s docblock states: a crisp
   * "does the route have other content" derivation needs more than either
   * seam owns, and this ships the identity-match version rather than block
   * on that.
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
  // Surface-side away predicate retained until route placements stop knowing
  // about shell placement. // #928 step 5
  return action !== null && action.occupantInstanceId === instance.instanceId;
}

export const WorkspacePaneDockContext =
  createContext<WorkspacePaneDockAction | null>(null);

export function useWorkspacePaneDockAction(): WorkspacePaneDockAction | null {
  return useContext(WorkspacePaneDockContext);
}
