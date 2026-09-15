/**
 * @vitest-environment jsdom
 */

/**
 * #2081, the per-turn half: the answer's `…` menu could not be closed by
 * pressing the control that opened it.
 *
 * This menu is not portalled — the issue frames the defect as a consequence of
 * portalling, and that is not the condition. The condition is that the TRIGGER
 * IS NOT INSIDE THE MENU CONTAINER, which is just as true of a sibling
 * (`TurnActionsMenu.tsx:33-43` beside `:46-91`) as of a portal. So pressing the
 * trigger moves focus out of the container, `useMenuFocus` dismisses on that
 * `focusout`, React flushes it, and the trigger's own click reads the
 * already-false `open` and re-opens the menu it was pressed to dismiss.
 *
 * Unlike the header's other menus this one has no dismiss backdrop over the
 * viewport, so the trigger really is pressable while the menu is open — see the
 * report on #2081 for why the profile, overflow, Layout and dock-More menus are
 * not reachable in that state and are left alone.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import TurnActionsMenu from '../components/chat/TurnActionsMenu';
import { pointerClick } from './helpers/pointer';

const FORK_SOURCE = { turnId: 'turn-1', agentSlug: 'agent-1' };

function renderMenu() {
  render(<TurnActionsMenu forkSource={FORK_SOURCE} onForkFromTurn={vi.fn()} />);
  return screen.getByRole('button', { name: 'More answer actions' });
}

const menu = () => screen.queryByRole('menu', { name: 'Answer actions' });

describe('#2081 — the turn actions trigger closes its own menu', () => {
  test('a pointer click on the trigger closes the menu, it does not reopen it', () => {
    const trigger = renderMenu();

    pointerClick(trigger);
    const opened = menu();
    expect(opened).not.toBeNull();
    // Focus must have entered the menu, or the `focusout` the second press
    // relies on was never armed and the assertion below would hold against the
    // defect too.
    expect(opened?.contains(document.activeElement)).toBe(true);

    // THE CLOSING GESTURE IS SPLIT, and that is the point of this test rather
    // than tidiness. Fired as one `pointerClick`, the whole thing rested on the
    // helper's `act()` flush landing the dismissal before the click: delete
    // that one line and this test passes against the restored defect, because
    // the click then closes over a stale `open` and the re-open never happens.
    // The reviewer showed the same removal also disarms
    // `ProjectSidebarFooter.test.tsx`'s pointer test, 33/33 green against the
    // presence tray's own defect — so a one-line tidy in a helper now serving
    // three suites could silently retire two regressions.
    //
    // Asserting BETWEEN the press and the release removes that dependency. The
    // press dismissing the menu is true of the browser whenever it happens, and
    // if the flush stops landing this line reds instead of the test quietly
    // losing its power. The second assertion is then the real claim: the click
    // does not bring back what the press took away.
    fireEvent.mouseDown(trigger);
    act(() => {
      trigger.focus();
    });
    expect(menu()).toBeNull();

    fireEvent.click(trigger, { detail: 1 });

    expect(menu()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // No return-focus assertion: the press above focuses the trigger, so
    // `document.activeElement === trigger` would hold whatever `useMenuFocus`
    // did with it. That contract is pinned in `portalled-menu-focus.test.tsx`.
  });
});
