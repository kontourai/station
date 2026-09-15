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

import { render, screen } from '@testing-library/react';
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

    pointerClick(trigger);

    expect(menu()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // `useMenuFocus` restores to the trigger rather than leaving focus on
    // `document.body`, which `applyReturnFocus` deliberately refuses.
    expect(document.activeElement).toBe(trigger);
  });
});
