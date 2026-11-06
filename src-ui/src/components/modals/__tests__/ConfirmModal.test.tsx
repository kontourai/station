/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ConfirmModal } from '../ConfirmModal';

/** RDS restores focus inside a `requestAnimationFrame` callback. */
async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function TriggerHarness({
  onHostClick,
  onHostPointerDown,
  onConfirm,
  pending = false,
  error = null,
  confirmDisabled = false,
}: {
  onHostClick?: () => void;
  onHostPointerDown?: () => void;
  onConfirm?: () => void;
  pending?: boolean;
  error?: string | null;
  confirmDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The root-level `onClick` mirrors ACPConnectionCard: a container that both
  // handles clicks and renders the dialog. That is the shape the portal leaked
  // into, so the fixture has to keep it rather than tidy it away — the
  // suppression is for the fixture's own missing role, which has no bearing on
  // whether a synthetic event crosses the portal.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: fixture reproduces the reported host shape
    // biome-ignore lint/a11y/useKeyWithClickEvents: fixture reproduces the reported host shape
    <div onClick={onHostClick} onPointerDown={onHostPointerDown}>
      <button type="button" onClick={() => setOpen(true)}>
        Remove connection
      </button>
      <ConfirmModal
        isOpen={open}
        title="Remove Connection"
        message="This cannot be undone."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={onConfirm ?? (() => setOpen(false))}
        onCancel={() => setOpen(false)}
        pending={pending}
        error={error}
        confirmDisabled={confirmDisabled}
      />
    </div>
  );
}

describe('ConfirmModal focus contract (station#1110)', () => {
  test('opens with focus inside the dialog and restores the trigger on close', async () => {
    const onConfirm = vi.fn();
    const view = render(<TriggerHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Remove connection' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancel' }),
    );

    const confirm = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    view.rerender(<TriggerHarness onConfirm={onConfirm} pending />);
    const pending = screen.getByRole('button', { name: 'Remove…' });
    expect(pending).toBe(confirm);
    expect(pending).toHaveProperty('disabled', false);
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(pending);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty(
      'disabled',
      false,
    );

    view.rerender(
      <TriggerHarness onConfirm={onConfirm} error="Removal unavailable." />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Removal unavailable.');
    expect(confirm.getAttribute('aria-busy')).toBeNull();
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);
    view.rerender(<TriggerHarness onConfirm={onConfirm} confirmDisabled />);
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await settleFocus();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('Tab from the last control wraps to the first instead of leaving the dialog', () => {
    render(<TriggerHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));

    // Three controls now, in DOM order: the header close X (SHELL-02 — the
    // shared `Dialog` gives every dialog one, where Delete Job used to be the
    // only dialog in the app without it), then Cancel, then the confirm.
    const close = screen.getByRole('button', {
      name: 'Close Remove Connection',
    });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Remove' });

    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});

describe('ConfirmModal portal containment (station#1111)', () => {
  test('dismissing by backdrop does not reach the host component click handler', () => {
    const onHostClick = vi.fn();
    render(<TriggerHarness onHostClick={onHostClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
    onHostClick.mockClear();

    const overlay = document.querySelector('.station-dialog__overlay');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.click(overlay!);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onHostClick).not.toHaveBeenCalled();
  });

  test('activating a dialog control does not reach the host component click handler', () => {
    const onHostClick = vi.fn();
    render(<TriggerHarness onHostClick={onHostClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
    onHostClick.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onHostClick).not.toHaveBeenCalled();
  });

  // Review of archive#1138: the backdrop tests above passed for the WRONG reason and
  // left `onPointerDown={containToPortal}` with zero coverage. The surface
  // dismisses on pointerdown, so the portal is already detached by the time the
  // following click is dispatched — it lands in a detached tree and reaches
  // nothing whether or not the wrapper contains it. Proven by deleting the
  // pointerdown handler and watching all 7 tests stay green.
  //
  // Firing on a control INSIDE the panel keeps the tree mounted, so the wrapper
  // handler is genuinely on the event path.
  test('a pointerdown inside the dialog does not reach the host component', () => {
    const onHostPointerDown = vi.fn();
    render(<TriggerHarness onHostPointerDown={onHostPointerDown} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove connection' }));
    onHostPointerDown.mockClear();

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.pointerDown(cancel);

    // Still open — the point is that the tree is mounted while the event
    // travels, unlike the backdrop case.
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(onHostPointerDown).not.toHaveBeenCalled();
  });

  test('two open dialogs label themselves with distinct ids', () => {
    render(
      <>
        <ConfirmModal
          isOpen
          title="Disable Connection"
          message="Disable it?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
        <ConfirmModal
          isOpen
          title="Remove Connection"
          message="Remove it?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </>,
    );

    const [first, second] = screen.getAllByRole('dialog');
    const firstId = first.getAttribute('aria-labelledby');
    const secondId = second.getAttribute('aria-labelledby');

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    // A duplicate id resolves to whichever element the document holds first, so
    // assert each dialog's label lands on its own title rather than the other's.
    expect(document.getElementById(firstId!)?.textContent).toBe(
      'Disable Connection',
    );
    expect(document.getElementById(secondId!)?.textContent).toBe(
      'Remove Connection',
    );
  });
});
