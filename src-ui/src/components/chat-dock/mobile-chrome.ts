export interface MobileDockFullscreenInput {
  isMobile: boolean;
  isDockOpen: boolean;
  isDockMaximized: boolean;
  /**
   * Whether the currently displayed view is one the ambient dock owns —
   * ANY occupant (Chat, Home, Activity), not Chat specifically
   * (station#4460: the shared `DockShell` behaves identically regardless of
   * which occupant is docked, so this predicate no longer names "chat").
   */
  isDockOwnedView: boolean;
}

/**
 * Whether the ambient dock currently owns the whole mobile viewport, which is
 * exactly the condition under which the app toolbar is hidden.
 *
 * Two places need this answer and they must not drift: `App.tsx` uses it to hide
 * the toolbar (and to reduce `--app-toolbar-total-height` to the safe-area
 * inset), and `ChatDockMobileHeader` uses it to decide whether to render its own
 * drawer toggle. When they disagreed, both toggles rendered at once and
 * `getByRole('button', { name: 'Toggle menu' })` matched two elements — a strict
 * -mode failure in the e2e suite, and a genuinely ambiguous control for anyone
 * driving the UI by accessible name (docs/design/chat-composer.md §1).
 *
 * Renamed from `isMobileChatFullscreen` (station#4460): a maximized Home or
 * Activity occupant hides the toolbar exactly the same way Chat does now
 * that every occupant shares the same `DockShell` chrome (maximize/restore,
 * collapse), so the old chat-only name asserted something it no longer
 * means. The maximized-dock trap this used to leave for a non-chat occupant
 * (toolbar hidden, no restore control reachable) dies structurally: the
 * shell's own header is present for every occupant, so a restore control is
 * always on screen.
 *
 * Desktop edge preferences do not change mobile placement: every mobile dock
 * is a bottom sheet, so a persisted left/right preference must not keep the
 * app toolbar visible over a maximized dock.
 */
export function isMobileDockFullscreen({
  isMobile,
  isDockOpen,
  isDockMaximized,
  isDockOwnedView,
}: MobileDockFullscreenInput): boolean {
  return isMobile && isDockOwnedView && isDockOpen && isDockMaximized;
}

/**
 * Whether a resolved navigation view type is one the ambient dock owns when
 * maximized. Layout routes AND direct workspace-pane routes render their own
 * workspace content (LayoutRenderer/tab strips), so hiding the app toolbar
 * under a stale dock snap there strands the user with no chrome (#2636 —
 * both leaks observed/derived from the same class). Every caller of
 * `isMobileDockFullscreen` must derive `isDockOwnedView` through this one
 * predicate.
 */
export function isDockOwnedViewType(viewType: string): boolean {
  return viewType !== 'layout' && viewType !== 'workspace-pane';
}

/**
 * station#520 (mobile dock-and-empty contract): whether docking a pane
 * "as only content" (`WorkspacePaneDockAction`'s "Dock this pane", called by
 * a pane on itself — see `WorkspacePaneDockAction` on
 * `WorkspacePaneDockContext` for the full contract this implements) should
 * also force the dock open MAXIMIZED, rather than leaving it at whatever
 * snap it already had.
 *
 * True only when BOTH hold: the device is mobile (every mobile dock is a
 * bottom bar — desktop's side/bottom panel already leaves room beside it,
 * so this is a phone-only behavior change) AND the dock action actually
 * admitted the pane (`docked`) — maximizing after a REFUSED request would
 * open the dock over nothing, which is a bug this guards against, not the
 * contract (station#520 review).
 */
export function shouldMaximizeAfterDockingAsOnlyContent(
  isMobile: boolean,
  docked: boolean,
): boolean {
  return isMobile && docked;
}

/**
 * station#520 (review round 2, M3): `DockOccupantPicker`'s onChoose seam.
 * Closing the picker's own gap in the mobile dock-and-empty contract — a
 * picker choice is a different call site from "Dock this pane"
 * (`WorkspacePaneDockAction`), but picking Home from the picker WHILE
 * standing on `/` reproduces the exact same stranding: the main area is
 * already `/`'s route, and docking Home there makes it the away-state
 * placeholder with nothing else behind it.
 *
 * True only when the device is mobile AND the picked pane's OWN route
 * (`ambientDockOccupantRouteViewType`) is the CURRENT route
 * (`currentViewType`, from `resolveViewFromPath(pathname).type`) — i.e. the
 * main area IS that pane's route right now, so docking it would strand
 * that same area behind the dock. Picking Home while standing on
 * `/settings`, or Chat (whose `pickedViewType` is always `null` — it has no
 * route of its own), never matches.
 */
export function shouldMaximizeOnOccupantChoice(
  isMobile: boolean,
  currentViewType: string,
  pickedViewType: string | null,
): boolean {
  return (
    isMobile && pickedViewType !== null && pickedViewType === currentViewType
  );
}
