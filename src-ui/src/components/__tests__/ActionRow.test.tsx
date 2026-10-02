/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ActionRow } from '../ActionRow';

const item = (key: string, label: string, extra: object = {}) => ({
  key,
  label,
  onSelect: vi.fn(),
  ...extra,
});

describe('ActionRow', () => {
  test('shows the two labelled actions and folds the rest behind one named trigger', () => {
    const exportItem = item('export', 'Export');
    render(
      <ActionRow
        overflowLabel="More skill actions"
        secondary={<button type="button">Test</button>}
        primary={<button type="button">Save</button>}
        overflow={[exportItem, item('duplicate', 'Duplicate')]}
      />,
    );

    // Three buttons on the row: two labelled, one ⋯. Nothing folded is a
    // button until the menu opens.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Test',
      'Save',
      '⋯',
    ]);
    const trigger = screen.getByRole('button', { name: 'More skill actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(trigger);
    expect(
      screen.getByRole('menu', { name: 'More skill actions' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }));
    expect(exportItem.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a single folded action stays behind the trigger rather than becoming a third label', () => {
    render(
      <ActionRow
        overflowLabel="More plan actions"
        secondary={<button type="button">Copy</button>}
        primary={<button type="button">Save</button>}
        overflow={[item('export', 'Export')]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'More plan actions' }),
    ).toBeTruthy();
  });

  test('danger items render last, after a separator, wherever they were listed', () => {
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[
          item('remove', 'Remove', { tone: 'danger' }),
          item('edit', 'Edit'),
          item('share', 'Share'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    const menu = screen.getByRole('menu');
    expect(
      [...menu.children].map((child) =>
        child.getAttribute('role') === 'menuitem'
          ? child.textContent
          : child.tagName,
      ),
    ).toEqual(['Edit', 'Share', 'HR', 'Remove']);
    expect(
      screen.getByRole('menuitem', { name: 'Remove' }).className,
    ).toContain('action-overflow__row--danger');
    expect(
      screen.getByRole('menuitem', { name: 'Edit' }).className,
    ).not.toContain('danger');
  });

  test('a menu of only danger items has no separator above it', () => {
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[item('remove', 'Remove', { tone: 'danger' })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu').querySelector('hr')).toBeNull();
  });

  test('a refused item with a reason is reachable, described, and does nothing', () => {
    const blocked = item('recovery', 'Create recovery link', {
      disabled: true,
      disabledReason: 'Sign-in is disabled',
    });
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[item('other', 'Other'), blocked]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');

    // The NAME is the label alone; the reason is the description.
    const row = screen.getByRole('menuitem', { name: 'Create recovery link' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect((row as HTMLButtonElement).disabled).toBe(false);
    expect(
      document.getElementById(row.getAttribute('aria-describedby')!)
        ?.textContent,
    ).toBe('Sign-in is disabled');

    // Arrow keys land on it, so a keyboard user can hear why.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row);

    fireEvent.click(row);
    expect(blocked.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('a disabled item with NO reason keeps the native attribute and is skipped', () => {
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[
          item('a', 'One'),
          item('b', 'Two', { disabled: true }),
          item('c', 'Three'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const two = screen.getByRole('menuitem', { name: 'Two' });
    expect((two as HTMLButtonElement).disabled).toBe(true);
    expect(two.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Three' }),
    );
  });

  test('Escape closes the menu and returns focus to its trigger', () => {
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[item('a', 'One'), item('b', 'Two')]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    // NOT focused first: a pointer press does not focus a button in every
    // browser, and then the menu's generic focus return has nothing recorded
    // to go back to. Escape must put focus on the trigger itself.
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'One' }),
    );

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('a row with no labelled action gives its trigger a word, and a name containing it', () => {
    const { unmount } = render(
      <ActionRow
        overflowLabel="Manage Kiro CLI"
        overflow={[item('a', 'Disable'), item('b', 'Remove')]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Manage Kiro CLI' });
    expect(trigger.textContent).toBe('Manage⋯');
    expect(trigger.className).toContain('action-overflow__trigger--labelled');
    unmount();

    // The word is the label's own first word, so the name is one phrase
    // that begins with what is shown (WCAG 2.5.3) — never "Manage: More …".
    render(
      <ActionRow
        overflowLabel="More actions for Studio Mac"
        overflow={[item('a', 'Edit'), item('b', 'Remove')]}
      />,
    );
    const other = screen.getByRole('button', {
      name: 'More actions for Studio Mac',
    });
    expect(other.textContent).toBe('More⋯');
  });

  test('the glyph column exists only when a row has a glyph', () => {
    const { unmount } = render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[item('a', 'One'), item('b', 'Two')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(
      screen.getByRole('menu').querySelector('.menu-row__glyph'),
    ).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'One' }).textContent).toBe(
      'One',
    );
    unmount();

    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[
          item('a', 'One', { glyph: <svg data-testid="glyph" /> }),
          item('b', 'Two'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    // Every row reserves the slot, so the two labels share an x.
    expect(
      screen.getByRole('menu').querySelectorAll('.menu-row__glyph').length,
    ).toBe(2);
    expect(screen.getByTestId('glyph')).toBeTruthy();
  });

  test('a disclosure row reports its state without claiming a popup', () => {
    render(
      <ActionRow
        overflowLabel="More actions"
        primary={<button type="button">Save</button>}
        overflow={[
          item('share', 'Share devices…', { expanded: false }),
          item('edit', 'Edit'),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const share = screen.getByRole('menuitem', { name: 'Share devices…' });
    expect(share.getAttribute('aria-expanded')).toBe('false');
    expect(share.hasAttribute('aria-haspopup')).toBe(false);
    expect(
      screen
        .getByRole('menuitem', { name: 'Edit' })
        .hasAttribute('aria-expanded'),
    ).toBe(false);
  });

  test('dismissing the menu does not click whatever the row sits inside', () => {
    const onHostClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a clickable card.
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for a clickable card.
      <div onClick={onHostClick}>
        <ActionRow
          overflowLabel="More actions"
          primary={<button type="button">Save</button>}
          overflow={[item('a', 'One'), item('b', 'Two')]}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close more actions' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onHostClick).not.toHaveBeenCalled();
  });

  describe('placement, from measured geometry', () => {
    type Box = { left: number; top: number; width: number; height: number };
    /**
     * jsdom lays nothing out, so each case states the two boxes the component
     * measures — the trigger's and the menu's — and the menu's content height.
     */
    function withGeometry(
      geometry: { trigger: Box; menu: Box; contentHeight?: number },
      run: () => void,
    ) {
      const rect = (box: Box) =>
        ({
          ...box,
          right: box.left + box.width,
          bottom: box.top + box.height,
        }) as DOMRect;
      const rects = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return rect(
            this.getAttribute('role') === 'menu'
              ? geometry.menu
              : geometry.trigger,
          );
        });
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockReturnValue(geometry.contentHeight ?? geometry.menu.height);
      const clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockReturnValue(geometry.menu.height);
      try {
        run();
      } finally {
        rects.mockRestore();
        scrollHeight.mockRestore();
        clientHeight.mockRestore();
      }
    }
    function openMenu() {
      render(
        <ActionRow
          overflowLabel="More actions"
          primary={<button type="button">Save</button>}
          overflow={[item('a', 'Disable'), item('b', 'Remove')]}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      return screen.getByRole('menu');
    }
    // jsdom's window: 1024 x 768.

    test('with room, the right edge sits on the trigger and the menu opens below', () => {
      withGeometry(
        {
          trigger: { left: 748, top: 100, width: 32, height: 32 },
          menu: { left: 600, top: 138, width: 180, height: 80 },
        },
        () => {
          const menu = openMenu();
          expect(menu.style.right).toBe(`${window.innerWidth - 780}px`);
          expect(menu.style.left).toBe('');
          expect(menu.style.top).toBe('138px');
          expect(menu.style.bottom).toBe('');
          // Capped to the room below, so a long menu scrolls inside.
          expect(menu.style.maxHeight).toBe(`${768 - 132 - 6 - 8}px`);
          expect(menu.style.overflowY).toBe('auto');
        },
      );
    });

    test('a trigger at the left edge anchors the menu to its own left edge', () => {
      withGeometry(
        {
          trigger: { left: 20, top: 100, width: 32, height: 32 },
          menu: { left: -128, top: 138, width: 180, height: 80 },
        },
        () => {
          const menu = openMenu();
          expect(menu.style.left).toBe('20px');
          expect(menu.style.right).toBe('');
        },
      );
    });

    test('a menu wider than either side is pulled back inside the right gutter', () => {
      withGeometry(
        {
          trigger: { left: 900, top: 100, width: 32, height: 32 },
          menu: { left: 0, top: 138, width: 980, height: 80 },
        },
        () => {
          // 932 - 980 < 8, so not right-aligned; 1024 - 8 - 980 = 36.
          expect(openMenu().style.left).toBe('36px');
        },
      );
    });

    test('too tall for the room below, it opens above with its top edge on screen', () => {
      withGeometry(
        {
          trigger: { left: 748, top: 700, width: 32, height: 32 },
          menu: { left: 600, top: 0, width: 180, height: 300 },
        },
        () => {
          const menu = openMenu();
          expect(menu.style.top).toBe('');
          expect(menu.style.bottom).toBe(`${768 - 700 + 6}px`);
          // Room above is 700 - 6 - 8: the menu cannot be taller than that,
          // so its top edge cannot leave the viewport.
          expect(menu.style.maxHeight).toBe('686px');
        },
      );
    });

    test('taller than BOTH sides, it takes the larger side and scrolls inside', () => {
      withGeometry(
        {
          trigger: { left: 748, top: 150, width: 32, height: 32 },
          menu: { left: 600, top: 0, width: 180, height: 200 },
          contentHeight: 900,
        },
        () => {
          const menu = openMenu();
          // Below has 768 - 182 - 14 = 572; above has 136. Below wins.
          expect(menu.style.top).toBe('188px');
          expect(menu.style.maxHeight).toBe('572px');
        },
      );
    });

    /** Placement is batched to one per frame. */
    const nextFrame = () =>
      act(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );

    test('follows its trigger when the page scrolls or the window resizes', async () => {
      const geometry = {
        trigger: { left: 748, top: 100, width: 32, height: 32 },
        menu: { left: 600, top: 138, width: 180, height: 80 },
      };
      const rect = (box: Box) =>
        ({
          ...box,
          right: box.left + box.width,
          bottom: box.top + box.height,
        }) as DOMRect;
      const rects = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return rect(
            this.getAttribute('role') === 'menu'
              ? geometry.menu
              : geometry.trigger,
          );
        });
      try {
        const menu = openMenu();
        expect(menu.style.top).toBe('138px');

        geometry.trigger = { ...geometry.trigger, top: 40 };
        fireEvent.scroll(document.body);
        // Not yet: one placement per frame, however many events arrive.
        expect(menu.style.top).toBe('138px');
        await nextFrame();
        expect(menu.style.top).toBe('78px');

        geometry.trigger = { ...geometry.trigger, left: 400 };
        fireEvent(window, new Event('resize'));
        await nextFrame();
        expect(menu.style.right).toBe(`${window.innerWidth - 432}px`);

        // The menu's OWN scroll (it is height-capped) is not a reason to move.
        geometry.trigger = { ...geometry.trigger, top: 300 };
        fireEvent.scroll(menu);
        await nextFrame();
        expect(menu.style.top).toBe('78px');

        // Scrolled out of the viewport: nothing left to be attached to.
        geometry.trigger = { ...geometry.trigger, top: -200 };
        fireEvent.scroll(document.body);
        await nextFrame();
        expect(screen.queryByRole('menu')).toBeNull();
      } finally {
        rects.mockRestore();
      }
    });
  });

  test('renders nothing when it has no actions at all', () => {
    const { container } = render(<ActionRow overflowLabel="More actions" />);
    expect(container.firstChild).toBeNull();
  });
});
