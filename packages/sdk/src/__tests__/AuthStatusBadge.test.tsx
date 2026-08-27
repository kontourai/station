/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthStatusBadge } from '../components/AuthStatusBadge';
import { SDKContext, type SDKContextValue } from '../providers';

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

function renderBadge(renew = vi.fn()) {
  const sdk: SDKContextValue = {
    apiBase: '',
    contexts: {
      auth: {
        useAuth: () => ({
          status: 'expiring' as const,
          user: null,
          expiresAt: new Date(Date.now() + 20 * 60 * 1000),
          provider: 'test-provider',
          renew,
          isRenewing: false,
        }),
      },
    },
    hooks: {},
  };
  render(
    <SDKContext.Provider value={sdk}>
      <AuthStatusBadge />
    </SDKContext.Provider>,
  );
  const trigger = screen.getByRole('button');
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, renew };
}

describe('AuthStatusBadge renew dialog', () => {
  test('moves focus into the aria-modal dialog and traps Tab inside it', async () => {
    restorers.push(installLayout());
    renderBadge();

    screen.getByRole('dialog', { name: 'Renew Authentication' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Open Terminal' });

    // `aria-modal="true"` hides everything outside the dialog from assistive
    // technology. Focus has to follow, or the user is left on a trigger the AT
    // can no longer reach.
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    // Forward from the last focusable wraps to the first.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    // Backward from the first focusable wraps to the last.
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  test('hides the background from assistive technology while open', () => {
    const { trigger } = renderBadge();

    screen.getByRole('dialog', { name: 'Renew Authentication' });
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
    // ...and restores it on close, rather than leaving the app unreachable.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger.getAttribute('aria-hidden')).toBeNull();
  });

  test('closes on Escape and returns focus to the trigger', async () => {
    const { trigger } = renderBadge();

    screen.getByRole('dialog', { name: 'Renew Authentication' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(
      screen.queryByRole('dialog', { name: 'Renew Authentication' }),
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('dismisses on backdrop click without putting the backdrop in the tab order', () => {
    renderBadge();

    const dialog = screen.getByRole('dialog', { name: 'Renew Authentication' });
    const overlay = dialog.parentElement as HTMLElement;

    // An invisible full-viewport button here would be a tab stop that closes
    // the dialog the user just opened.
    expect(
      screen.queryByRole('button', { name: /Close renew authentication/i }),
    ).toBeNull();
    expect(
      Array.from(overlay.querySelectorAll('button')).filter(
        (button) => !dialog.contains(button),
      ),
    ).toHaveLength(0);

    // A click that originated inside the dialog must not dismiss it.
    fireEvent.click(dialog);
    screen.getByRole('dialog', { name: 'Renew Authentication' });

    fireEvent.click(overlay);
    expect(
      screen.queryByRole('dialog', { name: 'Renew Authentication' }),
    ).toBeNull();
  });
});
