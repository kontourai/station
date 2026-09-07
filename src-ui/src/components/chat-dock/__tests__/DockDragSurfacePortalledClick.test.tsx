/**
 * @vitest-environment jsdom
 *
 * #1638: a control inside a dock-mounted surface stays operable once that
 * surface portals out of the dock.
 *
 * WHAT THIS EXISTS TO CATCH: deleting `data-no-dock-drag` from
 * `ResponsiveDialogSurface`'s overlay. That one attribute is the whole fix,
 * and without a pin the only thing standing between its removal and a
 * product-wide regression is an end-to-end journey — expensive, and already
 * blocked once on this branch by an unrelated spec audit.
 *
 * THE MECHANISM, because this test asserts the behaviour rather than the
 * marker. `ChatDockMobileHeader` is the dock's drag surface and renders its
 * sheets INSIDE itself, so a press on a sheet control reaches
 * `useChatDockVerticalDrag`'s `onPointerDown` — a React prop, and React events
 * cross a portal through the component tree. That hook captures the pointer
 * immediately and documents why: "capture retargets the native click at the
 * surface, where it activates nothing". It compensates by replaying the click
 * on the pressed control, and the replay is gated on
 * `target.contains(pressedControl)` — DOM containment against the drag
 * surface. A portaled panel fails that check, so the capture fires and the
 * compensation does not: the click is consumed and the handler never runs.
 *
 * WHY THE ASSERTION IS "DID THE DOCK TAKE THE GESTURE" rather than "did the
 * click arrive". The damage is done by the capture, and jsdom has no
 * `setPointerCapture`, so it cannot reproduce a retargeted native click — a
 * test that fired its own `click` event would pass under both the fix and the
 * defect, and one that fired none would fail under both. Pointer capture is
 * the observable that actually diverges: with the opt-out the hook bails
 * BEFORE capturing, so the browser keeps the gesture and the control's own
 * click is never interfered with. Asserting the capture never happens is
 * therefore asserting the mechanism, at unit speed, without modelling the
 * browser behaviour that would decide the answer for us.
 *
 * The hook options mirror `useDockShellChrome`'s real mobile ones exactly
 * (`mobile-snap`, `ignoreInteractiveTargets`, `dragInteractiveTargets`) —
 * `dragInteractiveTargets` is what makes a press on a BUTTON enter the
 * gesture at all, so a fixture that omitted it would prove nothing.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useChatDockVerticalDrag } from '../../../hooks/useChatDockVerticalDrag';
import { ResponsiveDialogSurface } from '../../ResponsiveDialogSurface';

function DockHeaderWithSheet({ onRowClick }: { onRowClick: () => void }) {
  const { onPointerDown, onClickCapture } = useChatDockVerticalDrag({
    mode: 'mobile-snap',
    toolbarHeight: 44,
    collapsedHeight: 44,
    ignoreInteractiveTargets: true,
    dragInteractiveTargets: true,
    onSnap: vi.fn(),
    onCommitHeight: vi.fn(),
    onLiveHeight: vi.fn(),
    onDragStateChange: vi.fn(),
  });
  return (
    <div
      className="chat-dock__header chat-dock__mobile-header"
      data-dock-drag-surface=""
      data-testid="drag-surface"
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
    >
      <button type="button">Dock header control</button>
      <ResponsiveDialogSurface
        layer="popover"
        ariaLabel="Switch project"
        onClose={vi.fn()}
      >
        <button type="button" onClick={onRowClick}>
          Open Beta Project
        </button>
      </ResponsiveDialogSurface>
    </div>
  );
}

describe('a dock-mounted surface that portals out keeps its controls operable (#1638)', () => {
  test('the dock does not take the gesture for a press inside the portaled surface', () => {
    const onRowClick = vi.fn();
    render(<DockHeaderWithSheet onRowClick={onRowClick} />);

    const surface = screen.getByTestId('drag-surface');
    const capture = vi.fn();
    // jsdom defines no pointer-capture API, so the hook's optional call is a
    // no-op. Installing a spy is what makes the gesture decision observable.
    (
      surface as HTMLElement & { setPointerCapture: unknown }
    ).setPointerCapture = capture;

    const row = screen.getByRole('button', { name: 'Open Beta Project' });

    // Power guard 1: the row must genuinely be OUTSIDE the drag surface in the
    // DOM, or the containment predicate this models is not being exercised and
    // the assertion below holds for the wrong reason.
    expect(
      surface.contains(row),
      'the surface no longer portals out of the dock, so the containment ' +
        'predicate that broke the replay is not exercised and this test proves ' +
        'nothing. Re-point it at whatever escapes the dock now.',
    ).toBe(false);

    // Power guard 2: a press on a control that IS inside the drag surface must
    // still enter the gesture. Without this, an unconditional bail — or a hook
    // that stopped capturing at all — would satisfy the real assertion while
    // silently disabling mobile dock resizing.
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Dock header control' }),
      { button: 0, pointerId: 1 },
    );
    expect(
      capture,
      'a press on a control inside the drag surface no longer enters the dock ' +
        'gesture, so this fixture can no longer tell the two cases apart — ' +
        'mobile dock resizing is probably broken.',
    ).toHaveBeenCalled();
    capture.mockClear();

    fireEvent.pointerDown(row, { button: 0, pointerId: 2 });

    expect(
      capture,
      'the dock captured the pointer for a press inside the portaled surface. ' +
        '`useChatDockVerticalDrag` then retargets the native click at the drag ' +
        'surface and replays it only when `target.contains(pressedControl)` — ' +
        'which a portaled panel fails — so this control is now unclickable. ' +
        'The cause is almost certainly a missing `data-no-dock-drag` on ' +
        "`ResponsiveDialogSurface`'s overlay.",
    ).not.toHaveBeenCalled();
  });
});
