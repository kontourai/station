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
