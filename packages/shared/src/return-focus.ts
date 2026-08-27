/**
 * Return-focus for Station's dismissible surfaces (station#1206, #1245).
 *
 * Station's surfaces used to hand-roll `if (target?.isConnected)
 * target.focus()` inside their own `requestAnimationFrame`. That check was
 * written many times and fixed once (station#1187 / #1126), so every copy that
 * did not render `ResponsiveDialogSurface` kept the original defect.
 *
 * WHY THIS LIVES IN `packages/shared` AND NOT IN `src-ui` (station#1245). It
 * used to be `src-ui/src/lib/dialog-return-focus.ts`. One of the call sites
 * carrying the #1126 defect is `ConnectionManagerModalContent`, inside
 * `@kontourai/station-connect` — a package that cannot import from the app, so
 * the module boundary was the reason that copy was missed by two consecutive
 * sweeps. Pinning two copies to one behaviour with a shared test would have
 * left the divergence possible and merely detectable; moving the module to a
 * package both the app and `station-connect` already consume removes it.
 * `mcp-ui-csp.ts` is the precedent for a dependency-free DOM/browser module
 * living here.
 *
 * This is the implementation behind every return-focus restore in
 * `ResponsiveDialogSurface`, `CommandLauncher`, `ActiveWorkContextFrame`,
 * `SessionModelPicker`, `SshEnvironmentSetupModal`, `CommandPalette`,
 * `MobileTaskSwitcher`, `ProjectSidebar`'s mobile drawer, `useMenuFocus`,
 * `SessionsView`/`ChatDock`'s delegation launcher, and
 * `ConnectionManagerModalContent`.
 *
 * It is still NOT every focus move in the app, and this comment must not be
 * read as "the sweep is finished". station#1245's sweep found a second tier
 * that still restores focus its own way — `BranchToolbar`'s two menus,
 * `NotificationContainer`'s approval popover, `NewChatModal`'s mobile context
 * sheet, `SplitPaneLayout`'s mobile detail sheet, `ChatDockTabBar`'s
 * `<details>` menu, and the file-attachment button restores. Those were
 * assessed, not skipped: the follow-up is #1259.
 *
 * UNVERIFIED as of 2026-08-18: #1259 is closed as COMPLETED, which asserts
 * that tier was handled, while this list asserts it was not. One of the two
 * is stale and a coarse grep could not settle which. Do not treat either as
 * authoritative until someone checks the named components; see #3109.
 *
 * Verify before extending this list, and never assert coverage this module
 * has not been given.
 *
 * The policy (endorsed by #1187's independent review, unchanged here): restore
 * the trigger, and when the trigger did not survive the surface's own action,
 * fall back to the nearest surviving ancestor — WAI-ARIA APG's "sensible
 * substitute" is the container tier, and the ancestor chain *is* the DOM path
 * the trigger occupied. `document.body` is deliberately excluded: focusing it
 * is the bug (#1126).
 */

/**
 * The trigger followed by its ancestors, captured now, while all of them are
 * still attached. A destructive action removes the row the trigger lives on,
 * and React detaches that row on its own — which nulls the trigger's
 * `parentElement`, leaving nothing to walk at restore time.
 */
export function captureReturnFocus(
  explicitTarget?: HTMLElement | null,
): HTMLElement[] {
  const trigger =
    explicitTarget ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
  const chain: HTMLElement[] = [];
  for (
    let node = trigger;
    node && node !== document.body;
    node = node.parentElement
  ) {
    chain.push(node);
  }
  return chain;
}

/**
 * A cheap structural veto before we try to focus a node.
 *
 * `isConnected` answers "is it in the document", not "can it take focus"
 * (station#1206 gap 2). A collapsed section is still connected, and
 * `.focus()` on it is a silent no-op in a real browser, so the walk would stop
 * on a node that cannot hold focus and leave `activeElement` on `<body>` — the
 * exact outcome the fallback exists to prevent — plus a stray `tabindex` on a
 * hidden element.
 *
 * This is a filter, not the decision: the authoritative test is whether the
 * node actually took focus, which `applyReturnFocus` checks afterwards. The
 * two are complementary — jsdom happily "focuses" a `display: none` node, so
 * only this check can catch the collapsed-section case under vitest, while
 * only the post-focus check catches everything else (`inert`, an ancestor with
 * `content-visibility`, a UA refusal) in a browser.
 */
function isFocusCandidate(node: HTMLElement): boolean {
  if (node.hidden) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Restore focus, synchronously. Prefer `restoreReturnFocus`, which schedules
 * this after the closing surface has actually been torn down — except where
 * the caller's existing restore was synchronous and its timing is load-bearing
 * (`useMenuFocus` restores inside an effect cleanup).
 *
 * `surface` is the closing surface's own root. Focus already sitting somewhere
 * else and still attached means another actor claimed it in this same frame — a
 * follow-up dialog's `autoFocus`, a route change's own initial focus, the
 * element a user tabbed to out of a menu that dismisses on focusout — and
 * overriding that is station#1206 gap 1: a regression against pre-#1187
 * behaviour, where the detached trigger meant nothing happened and the other
 * actor won. Focus still inside our own surface is not another actor; it is our
 * teardown not having run yet, so we proceed.
 */
export function applyReturnFocus(
  chain: readonly HTMLElement[],
  surface?: HTMLElement | null,
): void {
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    active !== document.documentElement &&
    active.isConnected &&
    !surface?.contains(active)
  ) {
    return;
  }

  for (const node of chain) {
    if (!node.isConnected || !isFocusCandidate(node)) continue;
    // Programmatically focusable, never tabbable: tabindex="0" here would add
    // a tab stop to every list in the app. A successful attempt leaves the
    // attribute in place rather than cleaning it up on blur — it is inert (no
    // tab order change, no ring, since the UA ring is :focus-visible, nothing
    // announced) and setting it again on a later dialog is idempotent. A
    // failed attempt removes what it added, so a node that refused focus is
    // left exactly as it was found.
    const added = node.tabIndex < 0 && !node.hasAttribute('tabindex');
    if (added) node.setAttribute('tabindex', '-1');
    node.focus();
    if (document.activeElement === node) return;
    if (added) node.removeAttribute('tabindex');
  }
}

/**
 * Schedule `applyReturnFocus` for the next frame, once the closing surface has
 * been removed from the document. Returns the frame handle so callers that
 * restore on a state change (rather than on unmount) can cancel it.
 */
export function restoreReturnFocus(
  chain: readonly HTMLElement[],
  surface?: HTMLElement | null,
): number {
  return requestAnimationFrame(() => applyReturnFocus(chain, surface));
}
