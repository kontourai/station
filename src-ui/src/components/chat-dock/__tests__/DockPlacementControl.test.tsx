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

  test('a drag that wanders past the threshold and releases on empty space is not a click (#2185)', () => {
    // The rule this replaced suppressed only when the pointer had passed OVER
    // a target, so this exact gesture — move away, drop on nothing — left the
    // click alive and reopened the menu. Movement past the tolerance is what
    // kills the click now, wherever it lands.
    const onPlacementChange = renderControl();
    const handle = screen.getByRole('button', { name: 'Move the dock' });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.click(handle);

    expect(onPlacementChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: 'Dock placement' })).toBeNull();
    // Exactly one click is swallowed: the next plain press is a press.
    fireEvent.click(handle);
    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();
  });

  test('a press whose release the control never saw leaves no flag standing for the next one (#2185)', () => {
    // jsdom implements no pointer capture, so a press dragged off the control
    // and released elsewhere is a release this element never sees — the one
    // path that reaches no click to clear the flag at. The next `pointerdown`
    // is the second clear; without it this press would swallow the user's
    // next activation.
    const onPlacementChange = renderControl();
    const handle = screen.getByRole('button', { name: 'Move the dock' });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 80, clientY: 10 });
    fireEvent.pointerUp(document.body, {
      pointerId: 1,
      clientX: 80,
      clientY: 10,
    });
    expect(screen.queryByRole('menu', { name: 'Dock placement' })).toBeNull();

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.click(handle);

    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();
    expect(onPlacementChange).not.toHaveBeenCalled();
  });

  /**
   * The one dock behaviour the #2185 extraction moved behind an option: the
   * grab used to call `setMenuOpen(false)` inline on a primary press, and now
   * asks the hook to do it through `onDragStart`. A helper test cannot prove
   * that wire (tests/AGENTS.md), so this drives the control: with the menu
   * open, a press on the grab closes it BEFORE any release. Deleting the
   * `onDragStart` call in the hook, or the option at the call site, reds it —
   * and the user-visible defect that would ship is a drag begun with the
   * menu up that drops with the menu still up.
   */
  test('a press on the grab closes an open menu before the drag begins (#2185)', () => {
    renderControl();

    const handle = screen.getByRole('button', { name: 'Move the dock' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.click(handle);
    expect(screen.getByRole('menu', { name: 'Dock placement' })).toBeTruthy();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    expect(screen.queryByRole('menu')).toBeNull();
    // The overlay is up: the press is a drag in progress, not a dismissed menu.
    expect(screen.getByTestId('dock-placement-targets')).toBeTruthy();

    fireEvent.pointerCancel(handle, { pointerId: 1 });
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
