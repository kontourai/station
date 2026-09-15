/**
 * @vitest-environment jsdom
 */

/**
 * `useMenuTriggerToggle` on its own (#2081).
 *
 * Its two integration tests each drive a real menu, which is what proves the
 * defect is gone — but both reach the hook through `pointerClick`, and one of
 * them was disarmable by a change to that helper. This drives the decision
 * directly and states the state transitions as a table, so the rule the hook
 * implements is pinned somewhere the helper cannot reach.
 *
 * The case that matters has no browser in it at all: the state flips to false
 * BETWEEN the press and the click, because a dismissal ran. Every menu this
 * hook serves lives that sequence; here it is made explicit rather than
 * produced by a focus move.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { useMenuTriggerToggle } from '../hooks/useMenuTriggerToggle';

/**
 * A trigger over state the test can move underneath it, the way a dismissal
 * does. `dismissOnPress` is the whole defect in one prop: a menu that closes
 * itself when its own trigger is pressed.
 */
function Trigger({
  initiallyOpen,
  dismissOnPress = false,
  onOpen,
  onClose,
}: {
  initiallyOpen: boolean;
  dismissOnPress?: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const props = useMenuTriggerToggle(
    isOpen,
    () => {
      setIsOpen(true);
      onOpen();
    },
    () => {
      setIsOpen(false);
      onClose();
    },
  );
  return (
    <button
      type="button"
      {...props}
      onMouseDown={() => {
        props.onMouseDown();
        // Ordered after the hook's own handler on purpose: the browser's focus
        // move, and `NotificationHistory`'s document listener, both land after
        // React has dispatched this button's handlers. React flushes a discrete
        // event's updates before delivering the click, so by then `isOpen` is
        // false and only the recorded press-time state still knows otherwise.
        if (dismissOnPress) setIsOpen(false);
      }}
    >
      {isOpen ? 'open' : 'closed'}
    </button>
  );
}

function press(button: HTMLElement) {
  fireEvent.mouseDown(button);
  fireEvent.click(button, { detail: 1 });
}

describe('useMenuTriggerToggle', () => {
  test('a press on a closed trigger opens it', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Trigger initiallyOpen={false} onOpen={onOpen} onClose={onClose} />);
    press(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a press on an open trigger closes it', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Trigger initiallyOpen onOpen={onOpen} onClose={onClose} />);
    press(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  /** The defect, with the focus move replaced by the state change it causes. */
  test('a press that dismisses the menu still closes rather than reopening', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <Trigger
        initiallyOpen
        dismissOnPress
        onOpen={onOpen}
        onClose={onClose}
      />,
    );
    const button = screen.getByRole('button');

    press(button);

    // The dismissal already shut it; the click must not undo that. Reading the
    // live state here instead of the press-time one calls `onOpen`, which is
    // the re-open the user experiences as an inert control.
    expect(onOpen).not.toHaveBeenCalled();
    expect(button.textContent).toBe('closed');
  });

  test('a keyboard click reads the live state, not an abandoned press', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <Trigger
        initiallyOpen
        dismissOnPress
        onOpen={onOpen}
        onClose={onClose}
      />,
    );
    const button = screen.getByRole('button');

    // Pressed and abandoned: the menu is dismissed and no click follows, so
    // "it was open" is left recorded and is now stale.
    fireEvent.mouseDown(button);
    expect(button.textContent).toBe('closed');

    // Enter on the focused button. `detail: 0` is what a user agent reports for
    // a click it synthesised from a key, and there is no press behind it to
    // read — so the live state decides and this opens.
    fireEvent.click(button, { detail: 0 });

    expect(onOpen).toHaveBeenCalledOnce();
    expect(button.textContent).toBe('open');
  });
});
