// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RowMenu } from '../RowMenu';

afterEach(cleanup);

test('choosing an item returns focus to the trigger', () => {
  const onSelect = vi.fn();
  render(
    <RowMenu
      items={[
        {
          id: 'a',
          label: '1 hour',
          hint: '8 PM',
          group: 'Snooze until',
          onSelect,
        },
        { id: 'd', label: 'Dismiss', onSelect: vi.fn() },
      ]}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.click(trigger);
  const item = screen.getByRole('menuitem', { name: /^1 hour/ });
  // Its group heading describes it, so a screen reader hears "Snooze until".
  expect(item.getAttribute('aria-describedby')).toBeTruthy();
  fireEvent.click(item);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('Escape closes the menu back to its trigger', () => {
  render(
    <RowMenu items={[{ id: 'd', label: 'Dismiss', onSelect: vi.fn() }]} />,
  );
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('deferred items stay current while open and stop resolving when closed', () => {
  const initialSelect = vi.fn();
  const updatedSelect = vi.fn();
  const initialItems = vi.fn(() => [
    { id: 'action', label: 'Initial action', onSelect: initialSelect },
  ]);
  const updatedItems = vi.fn(() => [
    { id: 'action', label: 'Updated action', onSelect: updatedSelect },
  ]);
  const { rerender } = render(<RowMenu items={initialItems} />);
  expect(initialItems).not.toHaveBeenCalled();
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.click(trigger);
  expect(screen.getByRole('menuitem', { name: 'Initial action' })).toBeTruthy();
  rerender(<RowMenu items={updatedItems} />);
  expect(screen.queryByRole('menuitem', { name: 'Initial action' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Updated action' }));
  expect(updatedSelect).toHaveBeenCalledWith(trigger);
  expect(initialSelect).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('menu')).toBeNull();
  initialItems.mockClear();
  rerender(<RowMenu items={initialItems} />);
  expect(initialItems).not.toHaveBeenCalled();
});
