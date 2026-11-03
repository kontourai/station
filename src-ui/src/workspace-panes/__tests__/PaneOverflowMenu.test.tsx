// @vitest-environment jsdom

/**
 * The ⋯ menu the Browser and Device panes share: grouped rows, a value hint
 * in the row's name, and a floor that respects the chat dock only when the
 * pane sits outside it.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type PaneMenuItem, PaneOverflowMenu } from '../PaneOverflowMenu';

const VIEWPORT = 844;
const DOCK = 700;
const TRIGGER_BOTTOM = 130;

function rect(top: number, height: number) {
  return {
    top,
    bottom: top + height,
    left: 340,
    right: 382,
    width: 42,
    height,
    x: 340,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const items = (onScreenshot = vi.fn()): PaneMenuItem[] => [
  { kind: 'heading', id: 'capture', label: 'Capture' },
  { kind: 'action', id: 'shot', label: 'Screenshot', onSelect: onScreenshot },
  { kind: 'heading', id: 'inspect', label: 'Inspect' },
  {
    kind: 'action',
    id: 'console',
    label: 'Console',
    hint: '2 new',
    onSelect: vi.fn(),
  },
  {
    kind: 'action',
    id: 'reload',
    label: 'Reload without cache',
    hint: '⇧⌘R',
    hintKeys: 'Meta+Shift+R',
    onSelect: vi.fn(),
  },
];

function mount(insideDock: boolean, onScreenshot = vi.fn()) {
  const menu = (
    <PaneOverflowMenu label="More actions" items={items(onScreenshot)}>
      ⋯
    </PaneOverflowMenu>
  );
  return render(insideDock ? <div className="chat-dock">{menu}</div> : menu);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--dock-slot-size');
});

describe('PaneOverflowMenu', () => {
  test('rows sit in labelled groups; a value hint is part of the name, a shortcut is not', async () => {
    const onScreenshot = vi.fn();
    mount(false, onScreenshot);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'More actions' });
    expect(
      within(menu)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
    ).toEqual(['Capture', 'Inspect']);
    expect(
      within(menu).getByRole('menuitem', { name: 'Console: 2 new' }),
    ).toBeTruthy();
    const reload = within(menu).getByRole('menuitem', {
      name: 'Reload without cache',
    });
    expect(reload.getAttribute('aria-keyshortcuts')).toBe('Meta+Shift+R');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Screenshot' }));
    expect(onScreenshot).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test.each([
    // Outside the dock: 2px are left above its top edge, so the menu opens
    // upward into the 76px between the trigger (top 88) and the 8px edge.
    [false, 76],
    // Inside the dock (the phone sheet): 844 - 130 (trigger) - 4 - 8 below.
    [true, 702],
  ])(
    'inside the dock %s: the menu has room down to its floor (%i px)',
    async (insideDock, expected) => {
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT);
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      ).mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'menu') return rect(0, 600);
        return rect(TRIGGER_BOTTOM - 42, 42);
      });
      document.documentElement.style.setProperty(
        '--dock-slot-size',
        `${DOCK}px`,
      );
      mount(insideDock);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const menu = await screen.findByRole('menu', { name: 'More actions' });
      await waitFor(() => expect(menu.style.maxHeight).not.toBe(''));
      expect(Number.parseFloat(menu.style.maxHeight)).toBe(expected);
    },
  );
});
