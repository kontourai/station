/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
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
        overflow={[item('remove', 'Remove', { tone: 'danger' })]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu').querySelector('hr')).toBeNull();
  });

  test('a disabled item shows its reason without changing its name', () => {
    const blocked = item('recovery', 'Create recovery link', {
      disabled: true,
      disabledReason: 'Sign-in is disabled',
    });
    render(
      <ActionRow
        overflowLabel="More actions"
        overflow={[blocked, item('other', 'Other')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

    const row = screen.getByRole('menuitem', { name: 'Create recovery link' });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain('Sign-in is disabled');
    expect(row.getAttribute('aria-description')).toBe('Sign-in is disabled');
    fireEvent.click(row);
    expect(blocked.onSelect).not.toHaveBeenCalled();
  });

  test('dismissing the menu does not click whatever the row sits inside', () => {
    const onHostClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for a clickable card.
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for a clickable card.
      <div onClick={onHostClick}>
        <ActionRow
          overflowLabel="More actions"
          overflow={[item('a', 'One'), item('b', 'Two')]}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close more actions' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onHostClick).not.toHaveBeenCalled();
  });

  test('a menu that would open off the left edge is anchored to its trigger instead', () => {
    const rect = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        top: 100,
        bottom: 132,
        width,
        height: 32,
      }) as DOMRect;
    // A trigger 20px from the left edge: right-aligning a 180px menu to it
    // puts the menu's left edge at -128px.
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'menu'
          ? rect(-128, 180)
          : rect(20, 32);
      });
    try {
      render(
        <ActionRow
          overflowLabel="More actions"
          overflow={[item('a', 'Disable'), item('b', 'Remove')]}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const menu = screen.getByRole('menu');
      expect(menu.style.left).toBe('20px');
      expect(menu.style.right).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  test('a menu with room keeps its right edge on its trigger', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const left = this.getAttribute('role') === 'menu' ? 600 : 748;
        const width = this.getAttribute('role') === 'menu' ? 180 : 32;
        return {
          left,
          right: left + width,
          top: 100,
          bottom: 132,
          width,
          height: 32,
        } as DOMRect;
      });
    try {
      render(
        <ActionRow
          overflowLabel="More actions"
          overflow={[item('a', 'Disable'), item('b', 'Remove')]}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const menu = screen.getByRole('menu');
      expect(menu.style.left).toBe('');
      expect(menu.style.right).toBe(`${window.innerWidth - 780}px`);
    } finally {
      spy.mockRestore();
    }
  });

  test('renders nothing when it has no actions at all', () => {
    const { container } = render(<ActionRow overflowLabel="More actions" />);
    expect(container.firstChild).toBeNull();
  });
});
