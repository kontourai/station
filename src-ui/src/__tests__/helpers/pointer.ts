/**
 * A pointer press, as a browser performs it, for the menus that dismiss
 * themselves when focus or a press leaves them.
 *
 * jsdom fires the events it is told to fire and nothing else, and the step it
 * omits is the one every "the trigger cannot close its own menu" defect turns
 * on: pressing a button MOVES FOCUS to it. For an open menu that focus move is
 * a `focusout` of the menu container, which `useMenuFocus` dismisses on — so by
 * the time the trigger's own `click` handler runs, the menu is already closed
 * and a blind toggle re-opens what the user meant to dismiss. Firing `click`
 * alone passes with or without a fix, because jsdom moves focus for neither.
 *
 * This models the three things that make that sequence observable:
 *
 *   - `mousedown` is CANCELABLE, and cancelling it is what suppresses the
 *     browser's focus-on-press. A trigger that calls `preventDefault` there
 *     (`ProjectSidebarPresenceTray`) must therefore see focus stay put.
 *   - focus moves only if the press was not cancelled, and it moves inside
 *     `act` so React flushes whatever the resulting `focusout` dismissed. That
 *     flush is load-bearing rather than tidiness: a browser renders what the
 *     focus change caused BEFORE it delivers the click, so the click handler
 *     reads the post-dismissal state. Without it the handler closes over a
 *     stale `open`, the re-open never happens, and the test passes against the
 *     defect — which is what the first version of this helper did, caught only
 *     because an injection stayed green.
 *
 *     DELETING THAT `act` DISARMS A REGRESSION TEST IN ANOTHER FILE, silently.
 *     `ProjectSidebarFooter.test.tsx`'s "a pointer click on the trigger closes
 *     the tray" passes 33/33 against the presence tray's own restored defect
 *     with the flush removed (#2081 review). It reads as a tidy — the focus
 *     move looks like it needs no wrapper — and nothing fails to say
 *     otherwise. `TurnActionsMenuPointerDismiss.test.tsx` no longer depends on
 *     it: that test splits the press from the release and asserts the
 *     dismissal in between, so a lost flush reds it rather than quietly
 *     retiring it. The footer's test has not been given that shape, because it
 *     belongs to #2066's lane and its own assertion would need rewriting, not
 *     reordering — the presence tray CANCELS its press, so what is true there
 *     between press and release is the opposite. Until it is,
 *     this line is the only thing protecting it.
 *   - `click` fires regardless, carrying `detail: 1`. A real pointer click
 *     always reports its click count; only a click the UA synthesises from a
 *     key press has `detail: 0`, and jsdom's default of `0` would otherwise
 *     make every pointer press in a test indistinguishable from Enter.
 *
 * Extracted from `ProjectSidebarFooter.test.tsx`, where it was written for
 * #2066's presence tray, so the header and per-turn menus covered by #2081
 * press their triggers exactly the same way rather than each modelling the
 * browser slightly differently.
 */
import { act, fireEvent } from '@testing-library/react';

/** Press and release a control the way a mouse or a finger does. */
export function pointerClick(element: HTMLElement): void {
  const notCancelled = fireEvent.mouseDown(element);
  if (notCancelled)
    act(() => {
      element.focus();
    });
  fireEvent.click(element, { detail: 1 });
}
