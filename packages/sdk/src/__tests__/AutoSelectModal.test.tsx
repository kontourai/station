/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AutoSelectModal } from '../components/AutoSelectModal';

function installKeyboardViewport() {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      height: 360,
      offsetTop: 12,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

/**
 * jsdom has no layout, so `getClientRects()` is empty for every element and the
 * trap's visibility filter would discard all of them. Give the filter a layout
 * to see; the elements under test are all genuinely rendered.
 */
function installLayout() {
  const original = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 10, height: 10 }] as unknown as ReturnType<
      Element['getClientRects']
    >;
  };
  return () => {
    Element.prototype.getClientRects = original;
  };
}

const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length) restorers.pop()?.();
});

describe('AutoSelectModal', () => {
  test('binds picker geometry to the keyboard-reduced visual viewport', () => {
    installKeyboardViewport();
    render(
      <AutoSelectModal
        isOpen
        title="Open Conversation"
        items={[
          { id: 'one', title: 'First session' },
          { id: 'two', title: 'Second session' },
        ]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        showCancel
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Open Conversation' });
    const overlay = dialog.parentElement;
    expect(
      overlay?.style.getPropertyValue('--responsive-visual-viewport-height'),
    ).toBe('360px');
    expect(
      overlay?.style.getPropertyValue('--responsive-visual-viewport-top'),
    ).toBe('12px');
    // Two items plus Cancel. A fourth would mean the dismissal backdrop is back
    // in the tab order.
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  test('preserves keyboard selection and Escape dismissal exactly once', () => {
    installKeyboardViewport();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <AutoSelectModal
        isOpen
        title="Open Conversation"
        items={[
          { id: 'one', title: 'First session' },
          { id: 'two', title: 'Second session' },
        ]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const search = screen.getByPlaceholderText('Search...');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'two' }),
    );
    fireEvent.keyDown(search, { key: 'Escape' });
    // `toHaveBeenCalledOnce` is the double-invocation guard: the trap's
    // document-level Escape and a component-local Escape branch would both see
    // this one keypress.
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('dismisses on backdrop click without putting the backdrop in the tab order', () => {
    installKeyboardViewport();
    const onClose = vi.fn();
    render(
      <AutoSelectModal
        isOpen
        title="Open Conversation"
        items={[]}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Open Conversation' });
    const overlay = dialog.parentElement as HTMLElement;

    // Nothing focusable may sit between the overlay and the dialog: an
    // invisible full-viewport button here is a tab stop that closes the surface
    // the user just opened.
    expect(
      screen.queryByRole('button', { name: /Close .* dialog/ }),
    ).toBeNull();
    expect(
      Array.from(overlay.querySelectorAll('button')).filter(
        (button) => !dialog.contains(button),
      ),
    ).toHaveLength(0);

    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();

    // A click that originated inside the dialog must not dismiss it.
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('moves focus into the dialog and traps Tab inside it', async () => {
    installKeyboardViewport();
    restorers.push(installLayout());
    render(
      <AutoSelectModal
        isOpen
        title="Open Conversation"
        items={[{ id: 'one', title: 'First session' }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        showCancel
      />,
    );

    const search = screen.getByPlaceholderText('Search...');
    const cancel = screen.getByRole('button', { name: 'Cancel' });

    await waitFor(() => expect(document.activeElement).toBe(search));

    // Forward from the last focusable wraps to the first.
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(search);

    // Backward from the first focusable wraps to the last.
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});
