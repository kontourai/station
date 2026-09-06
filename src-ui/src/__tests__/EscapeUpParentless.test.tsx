/**
 * @vitest-environment jsdom
 */

/**
 * #1582 H3: on Schedule, opening Add Job and pressing Escape twice navigated
 * to Home. The dialog was never the culprit — `ResponsiveDialogSurface` stops
 * the first Escape at the panel, so it never reaches the window dispatcher.
 * The second one did, and `app.escapeUp` was armed on a page with nothing
 * above it because `getParentView` fell back to Home for every unlisted view.
 *
 * This runs the real keydown path: the real `KeyboardShortcutsProvider`
 * dispatcher on `window`, the real `Dialog`, and the real `getParentView`
 * derivation App arms the shortcut from. `AppHomeRoute.test.tsx` pins that App
 * itself arms it this way; this file pins what a real key press then does.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Dialog } from '../components/Dialog';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { getParentView } from '../app-shell/routing';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import type { NavigationView } from '../types';

const goUp = vi.fn();

function Page({ view }: { view: NavigationView }) {
  const [addJobOpen, setAddJobOpen] = useState(false);
  const parentView = getParentView(view);
  useKeyboardShortcut(
    'app.escapeUp',
    'Escape',
    [],
    'Go up one level',
    () => {
      if (parentView) goUp(parentView);
    },
    parentView !== null,
    -100,
  );
  return (
    <>
      <button type="button" onClick={() => setAddJobOpen(true)}>
        Add job
      </button>
      {addJobOpen ? (
        <Dialog title="Add Job" onClose={() => setAddJobOpen(false)}>
          <input aria-label="Job name" />
        </Dialog>
      ) : null}
    </>
  );
}

function mount(view: NavigationView) {
  render(
    <KeyboardShortcutsProvider>
      <Page view={view} />
    </KeyboardShortcutsProvider>,
  );
}

beforeEach(() => {
  goUp.mockReset();
  window.history.replaceState({}, '', '/');
});

describe('Escape on a page with no level above it', () => {
  test('closes Add Job and then does nothing on Schedule', () => {
    mount({ type: 'schedule' });
    fireEvent.click(screen.getByRole('button', { name: 'Add job' }));
    const dialog = screen.getByRole('dialog');

    // First Escape: consumed by the dialog surface, which is why it never
    // reaches the window dispatcher even when the shortcut IS armed.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(goUp).not.toHaveBeenCalled();

    // Second Escape: no dialog left to consume it, so it reaches the real
    // dispatcher. Schedule is a top-level destination — nothing happens.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(goUp).not.toHaveBeenCalled();
  });

  test('does nothing on the resting page either, with no dialog involved', () => {
    mount({ type: 'schedule' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(goUp).not.toHaveBeenCalled();
  });

  test('still goes up from a view that declares a parent', () => {
    // The negative control: the dispatcher, the chord and this harness all
    // work — Schedule's silence is the derivation, not a dead test.
    mount({ type: 'settings' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(goUp).toHaveBeenCalledWith({ type: 'home' });
  });

  test('goes up to Agents from an agent edit view', () => {
    mount({ type: 'agent-edit', slug: 'claude' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(goUp).toHaveBeenCalledWith({ type: 'agents' });
  });
});
