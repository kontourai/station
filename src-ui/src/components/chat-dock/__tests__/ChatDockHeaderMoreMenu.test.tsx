/** @vitest-environment jsdom */

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockHeaderMoreMenu } from '../ChatDockHeaderMoreMenu';

const COMMAND = { key: 'a', label: 'Chat settings', onSelect: vi.fn() };
/**
 * A SECOND row, because one folded command renders inline instead of behind a
 * trigger (D2) — a menu of one is a second click for nothing. Every test about
 * the menu therefore needs at least two.
 */
const SECOND = { key: 'b', label: 'Copy project path', onSelect: vi.fn() };
const TWO = [COMMAND, SECOND];

describe('ChatDockHeaderMoreMenu', () => {
  test('renders nothing when it has no commands to fold', () => {
    const { container } = render(<ChatDockHeaderMoreMenu actions={[]} />);
    expect(container.querySelector('button')).toBeNull();
  });

  /**
   * D2: a menu holding ONE command costs a click and shows a list of one. The
   * decision is derived from the row count, not from a guess about which state
   * produces it — and the inline control carries the row's own LABEL, because an
   * unlabelled icon is the thing #1536 F set out to remove.
   */
  test('a single folded command renders inline, with no trigger and no menu', () => {
    const onSelect = vi.fn();
    render(<ChatDockHeaderMoreMenu actions={[{ ...COMMAND, onSelect }]} />);

    expect(
      screen.queryByRole('button', { name: /^More dock actions/ }),
    ).toBeNull();
    const inline = screen.getByRole('button', { name: 'Chat settings' });
    expect(inline.textContent).toBe('Chat settings');
    fireEvent.click(inline);
    expect(onSelect).toHaveBeenCalledWith(inline);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('a second command brings the trigger back', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);

    expect(
      screen.getByRole('button', { name: /^More dock actions/ }),
    ).toBeTruthy();
    // And the single row is no longer a control of its own in the bar.
    expect(screen.queryByRole('button', { name: 'Chat settings' })).toBeNull();
  });

  /**
   * L10: folding a command into one control must not drop what the control
   * promised. A row that opens a surface says so, a toggle reports its state,
   * and live work behind it stays visible — the inline form is the same command,
   * not a plainer one.
   */
  test('the inline form carries the row’s popup semantics, state and count', () => {
    const { unmount } = render(
      <ChatDockHeaderMoreMenu
        actions={[
          {
            key: 'tasks',
            label: 'Background tasks',
            haspopup: 'dialog',
            expanded: true,
            onSelect: vi.fn(),
          },
        ]}
        badgeCount={4}
        badgeLabel="4 background tasks running"
      />,
    );

    const inline = screen.getByRole('button', {
      name: 'Background tasks — 4 background tasks running',
    });
    expect(inline.getAttribute('aria-haspopup')).toBe('dialog');
    expect(inline.getAttribute('aria-expanded')).toBe('true');
    expect(inline.querySelector('.chat-dock__more-badge')?.textContent).toBe(
      '4',
    );
    unmount();

    render(
      <ChatDockHeaderMoreMenu
        actions={[
          {
            key: 'list',
            label: 'Collapse chat list',
            checked: true,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'Collapse chat list' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  test('the inline form keeps its own click off the header’s dock toggle', () => {
    const onHeaderClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for the dock header's toggle surface.
      <div onClick={onHeaderClick} onKeyDown={onHeaderClick}>
        <ChatDockHeaderMoreMenu actions={[COMMAND]} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chat settings' }));
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  test('opens a portalled menu, so the dock header cannot clip it', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ChatDockHeaderMoreMenu actions={[{ ...COMMAND, onSelect }, SECOND]} />,
    );

    const trigger = screen.getByLabelText('More dock actions');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'More dock actions' });
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat settings' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * A row that opens an anchored surface is handed the MENU'S TRIGGER, not the
   * row: the row is gone by the time the surface renders, and the trigger is
   * also where `SessionInventoryHost` stamps its `focusFullBasis` handle.
   */
  test('hands a row the trigger element, not the row that was pressed', () => {
    const onSelect = vi.fn();
    render(
      <ChatDockHeaderMoreMenu
        actions={[{ key: 'i', label: 'Session inventory', onSelect }, SECOND]}
      />,
    );

    const trigger = screen.getByLabelText('More dock actions');
    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Session inventory' }),
    );

    expect(onSelect).toHaveBeenCalledWith(trigger);
  });

  test('a toggle row carries its state; a command row claims none', () => {
    render(
      <ChatDockHeaderMoreMenu
        actions={[
          {
            key: 't',
            label: 'Collapse chat list',
            checked: true,
            onSelect: vi.fn(),
          },
          COMMAND,
          {
            key: 'd',
            label: 'Background tasks',
            haspopup: 'dialog',
            expanded: true,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText('More dock actions'));

    expect(
      screen
        .getByRole('menuitemcheckbox', { name: 'Collapse chat list' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    const command = screen.getByRole('menuitem', { name: 'Chat settings' });
    expect(command.hasAttribute('aria-checked')).toBe(false);
    expect(command.hasAttribute('aria-haspopup')).toBe(false);
    const dialogRow = screen.getByRole('menuitem', {
      name: 'Background tasks',
    });
    expect(dialogRow.getAttribute('aria-haspopup')).toBe('dialog');
    expect(dialogRow.getAttribute('aria-expanded')).toBe('true');
  });

  test('Escape and a backdrop click both dismiss it, and focus returns to the trigger', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);

    const trigger = screen.getByLabelText('More dock actions');
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole('button', { name: 'Close more dock actions' }),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('the trigger keeps the header row from treating its click as a dock toggle', () => {
    const onHeaderClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stand-in for the dock header's toggle surface.
      <div onClick={onHeaderClick} onKeyDown={onHeaderClick}>
        <ChatDockHeaderMoreMenu actions={TWO} />
      </div>,
    );

    fireEvent.click(screen.getByLabelText('More dock actions'));
    expect(onHeaderClick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('adopts a caller-owned trigger ref so an anchored surface has an anchor', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<ChatDockHeaderMoreMenu actions={TWO} triggerRef={ref} />);

    expect(ref.current).toBe(screen.getByLabelText('More dock actions'));
  });

  /**
   * The header sits at the top of a bottom dock, at the top of a side dock, and
   * in a 40px collapsed bar — so a menu fixed to one side of its trigger is off
   * screen in at least one of them. The trigger's own rect decides.
   */
  test('opens downward with room below and upward without it', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);
    const trigger = screen.getByLabelText('More dock actions');

    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 128,
      right: 900,
    } as DOMRect);
    fireEvent.click(trigger);
    let menu = screen.getByRole('menu', { name: 'More dock actions' });
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).toBe('134px');
    expect(menu.style.bottom).toBe('');
    fireEvent.keyDown(document, { key: 'Escape' });

    // A collapsed bottom dock: the trigger is a few pixels from the viewport
    // floor, so a downward menu would render off screen entirely.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 40,
      bottom: window.innerHeight - 12,
      right: 900,
    } as DOMRect);
    fireEvent.click(trigger);
    menu = screen.getByRole('menu', { name: 'More dock actions' });
    expect(menu.style.top).toBe('');
    expect(menu.style.bottom).toBe('46px');
  });

  test('the menu row family is the dock header’s own, not a new one', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);
    fireEvent.click(screen.getByLabelText('More dock actions'));

    expect(
      screen.getByRole('menu', { name: 'More dock actions' }).className,
    ).toContain('dock-placement-menu');
    expect(
      screen.getByRole('menuitem', { name: 'Chat settings' }).className,
    ).toContain('dock-placement-menu__item');
  });

  /**
   * M4: the backdrop sits immediately before the menu in document order, so as
   * a tab stop it was where Shift+Tab off the first row landed — and
   * `useMenuFocus` dismisses on focusout, so the menu closed instead of the
   * user walking back out of it. A pointer convenience is not a tab stop.
   */
  test('the dismiss backdrop is not a tab stop', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);
    fireEvent.click(screen.getByLabelText('More dock actions'));

    expect(
      screen
        .getByRole('button', { name: 'Close more dock actions' })
        .getAttribute('tabindex'),
    ).toBe('-1');
  });

  test('the rows are navigable with the arrow keys', () => {
    render(
      <ChatDockHeaderMoreMenu
        actions={[
          COMMAND,
          { key: 'b', label: 'Background tasks', onSelect: vi.fn() },
          { key: 'c', label: 'Copy thread ID', onSelect: vi.fn() },
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText('More dock actions'));
    const menu = screen.getByRole('menu', { name: 'More dock actions' });
    const items = [...menu.querySelectorAll<HTMLElement>('button')];
    expect(items).toHaveLength(3);

    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  /** M2: live work behind a folded row has to be visible with the menu closed. */
  test('carries a caller-supplied count on the trigger, in the badge and in its name', () => {
    render(
      <ChatDockHeaderMoreMenu
        actions={TWO}
        badgeCount={2}
        badgeLabel="2 background tasks running"
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'More dock actions — 2 background tasks running',
    });
    expect(trigger.getAttribute('title')).toBe(
      'More dock actions — 2 background tasks running',
    );
    // The painted badge is a glyph for the same fact, hence aria-hidden.
    const badge = trigger.querySelector('.chat-dock__more-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
  });

  test('renders no badge at zero, and no count in its name', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} badgeCount={0} />);

    const trigger = screen.getByRole('button', { name: 'More dock actions' });
    expect(trigger.querySelector('.chat-dock__more-badge')).toBeNull();
  });

  /** M1: a row that cannot act must not look pressable. */
  test('a disabled row is refused and skipped by roving focus', () => {
    const onSelect = vi.fn();
    render(
      <ChatDockHeaderMoreMenu
        actions={[
          COMMAND,
          {
            key: 'i',
            label: 'Session inventory — loading',
            disabled: true,
            onSelect,
          },
          { key: 'z', label: 'Copy thread ID', onSelect: vi.fn() },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: /^More dock actions/ });
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'More dock actions' });

    const row = screen.getByRole('menuitem', {
      name: 'Session inventory — loading',
    });
    expect(row.hasAttribute('disabled')).toBe(true);
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();

    // `useMenuFocus`'s focusable query excludes a disabled button, so Down from
    // the first row skips straight past it rather than parking on a dead row.
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Chat settings' }),
    );
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Copy thread ID' }),
    );
  });

  test('a pointerdown on the backdrop does not dismiss before the click lands', () => {
    render(<ChatDockHeaderMoreMenu actions={TWO} />);
    fireEvent.click(screen.getByLabelText('More dock actions'));

    const backdrop = screen.getByRole('button', {
      name: 'Close more dock actions',
    });
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });
});
