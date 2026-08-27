// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import SnoozeMenu from '../components/home/SnoozeMenu';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

const NOW = Date.parse('2026-07-28T15:00:00-06:00');

function renderMenu(overrides: Partial<Parameters<typeof SnoozeMenu>[0]> = {}) {
  const onSnooze = vi.fn();
  const onClose = vi.fn();
  const triggerRef = createRef<HTMLButtonElement>();
  render(
    <SnoozeMenu
      itemTitle="Review release"
      now={NOW}
      triggerRef={triggerRef}
      onSnooze={onSnooze}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSnooze, onClose };
}

describe('SnoozeMenu', () => {
  test('exposes the four agent-rhythm presets as real menu items', () => {
    renderMenu();
    const menu = screen.getByRole('menu', { name: 'Snooze Review release' });
    expect(menu).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'In 1 hour' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'This evening' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Tomorrow 9am' })).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'Next week Mon 9am' }),
    ).toBeTruthy();
  });

  test('selecting a preset calls onSnooze with its wake time and closes', () => {
    const { onSnooze, onClose } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'In 1 hour' }));
    expect(onSnooze).toHaveBeenCalledWith(NOW + 60 * 60 * 1000);
    expect(onClose).toHaveBeenCalled();
  });

  test('the close button dismisses without snoozing', () => {
    const { onSnooze, onClose } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Close snooze menu' }));
    expect(onClose).toHaveBeenCalled();
    expect(onSnooze).not.toHaveBeenCalled();
  });
});
