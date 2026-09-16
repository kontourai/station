/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DockPlacementTargets, usePlacementDrag } from '../placement-drag';
import { regionLabel } from '../region-model';

afterEach(() => vi.restoreAllMocks());

const PLACEMENTS = ['left', 'bottom', 'right'] as const;

/**
 * The smallest consumer: a grabbable button that spreads the handlers and
 * renders the overlay while dragging. `DockPlacementControl` is the shipped
 * consumer and keeps its own oracle; this pins the gesture without the menu
 * around it.
 */
function Grab({
  onDrop,
  onClick,
}: {
  onDrop: (placement: 'left' | 'bottom' | 'right') => void;
  onClick: () => void;
}) {
  const { dragging, hovered, handlers } = usePlacementDrag({
    placements: PLACEMENTS,
    onDrop,
    onClick,
  });
  return (
    <>
      <button type="button" {...handlers}>
        grab
      </button>
      {dragging ? (
        <DockPlacementTargets placements={PLACEMENTS} active={hovered} />
      ) : null}
    </>
  );
}

function renderGrab() {
  const onDrop = vi.fn();
  const onClick = vi.fn();
  render(<Grab onDrop={onDrop} onClick={onClick} />);
  return {
    onDrop,
    onClick,
    grab: screen.getByRole('button', { name: 'grab' }),
  };
}

function pointAt(element: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => element,
  });
}

describe('usePlacementDrag (#2185)', () => {
  test('a press that stays within the tolerance is a click', () => {
    const { grab, onClick, onDrop } = renderGrab();
    pointAt(null);

    fireEvent.pointerDown(grab, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(grab, { pointerId: 1, clientX: 14, clientY: 12 });
    fireEvent.pointerUp(grab, { pointerId: 1, clientX: 14, clientY: 12 });
    fireEvent.click(grab);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();
  });

  test('movement past the tolerance kills the click wherever it lands', () => {
    // 9px on one axis: past the 8px tolerance, over nothing.
    const { grab, onClick, onDrop } = renderGrab();
    pointAt(null);

    fireEvent.pointerDown(grab, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(grab, { pointerId: 1, clientX: 19, clientY: 10 });
    fireEvent.pointerUp(grab, { pointerId: 1, clientX: 19, clientY: 10 });
    const click = fireEvent.click(grab);

    expect(onClick).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    // Swallowed with its default, so a navigating consumer's link goes nowhere.
    expect(click).toBe(false);
  });

  test('a release over a target drops there and is not a click, at any distance', () => {
    const { grab, onClick, onDrop } = renderGrab();

    fireEvent.pointerDown(grab, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    pointAt(document.querySelector('[data-dock-placement-target="bottom"]'));
    fireEvent.pointerMove(grab, { pointerId: 1, clientX: 12, clientY: 12 });
    expect(
      document.querySelector('[data-dock-placement-target="bottom"]')
        ?.className,
    ).toContain('dock-placement-target--active');
    fireEvent.pointerUp(grab, { pointerId: 1, clientX: 12, clientY: 12 });
    fireEvent.click(grab);

    expect(onDrop).toHaveBeenCalledWith('bottom');
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();
  });

  test('a target the consumer did not offer is not a drop', () => {
    const onDrop = vi.fn();
    function Narrow() {
      const { dragging, handlers } = usePlacementDrag({
        placements: ['left'],
        onDrop,
      });
      return (
        <>
          <button type="button" {...handlers}>
            grab
          </button>
          {dragging ? <div data-dock-placement-target="right" /> : null}
        </>
      );
    }
    render(<Narrow />);
    const grab = screen.getByRole('button', { name: 'grab' });

    fireEvent.pointerDown(grab, { button: 0, pointerId: 1 });
    pointAt(document.querySelector('[data-dock-placement-target="right"]'));
    fireEvent.pointerUp(grab, { pointerId: 1 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  test('exactly one click is swallowed, and the next press clears a flag no click consumed', () => {
    // jsdom refuses capture, so a release off the element never reaches it:
    // no click arrives to consume the flag. The next `pointerdown` is the
    // other clear, and without it the press after a wandered one is dead.
    const { grab, onClick } = renderGrab();
    pointAt(null);

    fireEvent.pointerDown(grab, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(grab, { pointerId: 1, clientX: 90, clientY: 10 });
    fireEvent.pointerUp(document.body, {
      pointerId: 1,
      clientX: 90,
      clientY: 10,
    });

    fireEvent.pointerDown(grab, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerUp(grab, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.click(grab);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a secondary button starts nothing', () => {
    const { grab, onClick } = renderGrab();
    fireEvent.pointerDown(grab, { button: 2, pointerId: 1 });
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();
    fireEvent.pointerMove(grab, { pointerId: 1, clientX: 90, clientY: 90 });
    fireEvent.click(grab);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('pointer cancel and a lost capture both end the drag without a drop', () => {
    const { grab, onDrop } = renderGrab();
    fireEvent.pointerDown(grab, { button: 0, pointerId: 1 });
    expect(screen.getByTestId('dock-placement-targets')).toBeTruthy();
    fireEvent.pointerCancel(grab, { pointerId: 1 });
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();

    fireEvent.pointerDown(grab, { button: 0, pointerId: 2 });
    expect(screen.getByTestId('dock-placement-targets')).toBeTruthy();
    fireEvent.lostPointerCapture(grab, { pointerId: 2 });
    expect(screen.queryByTestId('dock-placement-targets')).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('DockPlacementTargets (#2185)', () => {
  test('renders one hidden target per placement, labelled by regionLabel', () => {
    render(<DockPlacementTargets placements={PLACEMENTS} active="right" />);
    const overlay = screen.getByTestId('dock-placement-targets');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const targets = overlay.querySelectorAll('[data-dock-placement-target]');
    expect([...targets].map((t) => t.textContent)).toEqual(
      PLACEMENTS.map(regionLabel),
    );
    // The same strings the control's private table produced before the
    // extraction — the table is gone because this derivation matches it.
    expect([...targets].map((t) => t.textContent)).toEqual([
      'Left',
      'Bottom',
      'Right',
    ]);
    expect(
      [...targets].filter((t) =>
        t.className.includes('dock-placement-target--active'),
      ),
    ).toHaveLength(1);
    expect(
      overlay.querySelector('.dock-placement-target--right')?.className,
    ).toContain('dock-placement-target--active');
  });
});
