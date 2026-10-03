/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { KeyboardShortcutsProvider } from '../KeyboardShortcutsContext';

function Chord({
  handler,
  id = 'test.chord',
  priority = 0,
}: {
  handler: () => void | boolean;
  id?: string;
  priority?: number;
}) {
  useKeyboardShortcut(
    id,
    'ArrowLeft',
    ['alt'],
    'Test chord',
    handler,
    true,
    priority,
  );
  return null;
}

function press() {
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowLeft',
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

/**
 * A handler that returns `false` had nothing to do: the key stays the
 * browser's (Alt+← is its own Back), not silently swallowed.
 */
test('a declining handler leaves the key unprevented; a handling one consumes it', () => {
  const declined = vi.fn(() => false);
  const view = render(
    <KeyboardShortcutsProvider>
      <Chord handler={declined} />
    </KeyboardShortcutsProvider>,
  );
  expect(press().defaultPrevented).toBe(false);
  expect(declined).toHaveBeenCalledOnce();

  const handled = vi.fn();
  view.rerender(
    <KeyboardShortcutsProvider>
      <Chord handler={handled} />
    </KeyboardShortcutsProvider>,
  );
  expect(press().defaultPrevented).toBe(true);
  expect(handled).toHaveBeenCalledOnce();
  view.unmount();
});

test('a declined key is offered to the next matching registration', () => {
  const declined = vi.fn(() => false);
  const next = vi.fn();
  render(
    <KeyboardShortcutsProvider>
      <Chord id="test.first" priority={10} handler={declined} />
      <Chord id="test.second" priority={0} handler={next} />
    </KeyboardShortcutsProvider>,
  );
  const event = press();
  expect(declined).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledOnce();
  expect(declined.mock.invocationCallOrder[0]).toBeLessThan(
    next.mock.invocationCallOrder[0]!,
  );
  expect(event.defaultPrevented).toBe(true);
});
