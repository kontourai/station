/**
 * The cross-tree "create a Board" trigger (#2062 review MED-6).
 *
 * ## Why an event and not a shared mutation hook
 *
 * The Boards section is hidden when the viewer has none, and the only `+`
 * lives inside that section, so a Station where nobody has made a Board offers
 * no way to make the first one. The remedy is a command-palette entry — and
 * the requirement on it is that it runs the SAME create the `+` runs, not a
 * second implementation that drifts.
 *
 * Calling the SDK mutation from the palette would have been the second
 * implementation: the palette would need its own slug derivation (the server
 * answers 409 for a repeat, so the derivation is part of the gesture, not
 * decoration), its own personal-layouts read to derive it from, and its own
 * answer for what to do afterwards. Instead the palette says what the user
 * asked for and `ProjectSidebarBoards` — which already holds the read, the
 * derivation, the mutation and the rename state — performs it.
 *
 * That works because of a property worth stating rather than relying on
 * silently: `ProjectSidebar` mounts the section UNCONDITIONALLY through a
 * `LazyBoundary`, and "hidden when empty" is the component returning `null`
 * from its own render. The listener is therefore alive for exactly the viewer
 * who cannot see the `+`. If the section is ever made conditional at the
 * mount site, this trigger goes dead — and `ProjectSidebarBoards.test.tsx`
 * drives the real palette against the real panel, so it would say so.
 *
 * Matching the repo's existing cross-tree idiom (`requestFirstRunTour`,
 * `open-command-palette`), which is also why the palette pays no SDK weight
 * in the eager bundle for this.
 */
export const NEW_BOARD_REQUEST_EVENT = 'station-new-board-request';

/** Asks whoever owns the Boards section to create one and open it. */
export function requestNewBoard(): void {
  window.dispatchEvent(new CustomEvent(NEW_BOARD_REQUEST_EVENT));
}
