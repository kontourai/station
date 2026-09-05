/** @vitest-environment jsdom */

import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockHeaderMoreMenu } from '../ChatDockHeaderMoreMenu';

const COMMAND = { key: 'a', label: 'Chat settings', onSelect: vi.fn() };

describe('ChatDockHeaderMoreMenu', () => {
  test('renders nothing when it has no commands to fold', () => {
    const { container } = render(<ChatDockHeaderMoreMenu actions={[]} />);
    expect(container.querySelector('button')).toBeNull();
  });

  test('opens a portalled menu, so the dock header cannot clip it', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ChatDockHeaderMoreMenu actions={[{ ...COMMAND, onSelect }]} />,
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
        actions={[{ key: 'i', label: 'Session inventory', onSelect }]}
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
    render(<ChatDockHeaderMoreMenu actions={[COMMAND]} />);

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
        <ChatDockHeaderMoreMenu actions={[COMMAND]} />
      </div>,
    );

    fireEvent.click(screen.getByLabelText('More dock actions'));
    expect(onHeaderClick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('adopts a caller-owned trigger ref so an anchored surface has an anchor', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<ChatDockHeaderMoreMenu actions={[COMMAND]} triggerRef={ref} />);

    expect(ref.current).toBe(screen.getByLabelText('More dock actions'));
  });

  /**
   * The header sits at the top of a bottom dock, at the top of a side dock, and
   * in a 40px collapsed bar — so a menu fixed to one side of its trigger is off
   * screen in at least one of them. The trigger's own rect decides.
   */
  test('opens downward with room below and upward without it', () => {
    render(<ChatDockHeaderMoreMenu actions={[COMMAND]} />);
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
    render(<ChatDockHeaderMoreMenu actions={[COMMAND]} />);
    fireEvent.click(screen.getByLabelText('More dock actions'));

    expect(
      screen.getByRole('menu', { name: 'More dock actions' }).className,
    ).toContain('dock-placement-menu');
    expect(
      screen.getByRole('menuitem', { name: 'Chat settings' }).className,
    ).toContain('dock-placement-menu__item');
  });

  test('a pointerdown on the backdrop does not dismiss before the click lands', () => {
    render(<ChatDockHeaderMoreMenu actions={[COMMAND]} />);
    fireEvent.click(screen.getByLabelText('More dock actions'));

    const backdrop = screen.getByRole('button', {
      name: 'Close more dock actions',
    });
    fireEvent(backdrop, createEvent.pointerDown(backdrop));
    expect(screen.queryByRole('menu')).not.toBeNull();
  });
});
