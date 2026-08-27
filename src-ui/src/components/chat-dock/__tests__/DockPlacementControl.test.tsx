/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DockPlacementControl } from '../DockPlacementControl';

afterEach(() => vi.restoreAllMocks());

function renderControl() {
  const onPlacementChange = vi.fn();
  render(
    <DockPlacementControl
      availablePlacements={['left', 'bottom', 'right']}
      effectivePlacement="left"
      onPlacementChange={onPlacementChange}
    />,
  );
  return onPlacementChange;
}

describe('dock placement control (#3930)', () => {
  test('the keyboard menu reaches the exact same placement writer as drag', () => {
    const onPlacementChange = renderControl();

    const handle = screen.getByRole('button', { name: 'Move the dock' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.click(handle);
    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Right' }));

    expect(onPlacementChange).toHaveBeenCalledWith('right');
  });

  test('pointer cancel restores without changing placement', () => {
    const onPlacementChange = renderControl();
    const handle = screen.getByRole('button', { name: 'Move the dock' });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    expect(screen.getByText('Right')).toBeTruthy();
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(onPlacementChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();
  });

  test('dragging to an available edge requests that placement', () => {
    const onPlacementChange = renderControl();
    const handle = screen.getByRole('button', { name: 'Move the dock' });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    const rightTarget = document.querySelector(
      '[data-dock-placement-target="right"]',
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => rightTarget,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 5, clientY: 5 });

    expect(onPlacementChange).toHaveBeenCalledWith('right');
  });

  test('dropping outside a target is a no-op', () => {
    const onPlacementChange = renderControl();
    const handle = screen.getByRole('button', { name: 'Move the dock' });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 1,
      clientY: 1,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 1, clientY: 1 });

    expect(onPlacementChange).not.toHaveBeenCalled();
  });

  test('Escape closes the menu and returns focus to the control that opened it', () => {
    const onPlacementChange = vi.fn();
    render(
      <DockPlacementControl
        availablePlacements={['left', 'right', 'bottom']}
        effectivePlacement="bottom"
        onPlacementChange={onPlacementChange}
      />,
    );

    const grab = screen.getByRole('button', { name: 'Move the dock' });
    fireEvent.click(grab);
    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    // A menu you cannot leave is worse than no menu, and a menu that closes
    // while focus stays on a now-absent item strands the keyboard user.
    expect(screen.queryByRole('menu', { name: 'Dock placement' })).toBeNull();
    expect(document.activeElement).toBe(grab);
    expect(onPlacementChange).not.toHaveBeenCalled();
  });

  test('a pointer press outside closes the menu without choosing anything', () => {
    const onPlacementChange = vi.fn();
    render(
      <DockPlacementControl
        availablePlacements={['left', 'right', 'bottom']}
        effectivePlacement="bottom"
        onPlacementChange={onPlacementChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move the dock' }));
    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menu', { name: 'Dock placement' })).toBeNull();
    expect(onPlacementChange).not.toHaveBeenCalled();
  });

  test('omits the handle when the device has only the bottom placement', () => {
    render(
      <DockPlacementControl
        availablePlacements={['bottom']}
        effectivePlacement="bottom"
        onPlacementChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Move the dock' })).toBeNull();
  });
});
