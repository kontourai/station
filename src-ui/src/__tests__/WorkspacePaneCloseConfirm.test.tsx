/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { paneCloseConfirmationProps } from '../workspace-panes/workspacePaneCloseConfirmation';

/**
 * archive#3157. The pane's unsaved-changes prompt was hand-rolled markup
 * under `.workspace-pane-host__close-confirmation` — a class with no CSS rule
 * anywhere in the repo. It rendered with no dialog surface at all, and
 * "Close pane", which discards unsaved work, was visually IDENTICAL to
 * "Cancel": both were unclassed <button>s falling through to the global
 * baseline.
 *
 * It now uses ConfirmModal, the answer this repo already had. These
 * assertions are the properties that made the hand-rolled version unsafe.
 */
describe('the pane close confirmation marks its destructive choice', () => {
// Render through the SAME props the component passes. An earlier version of
// this file hardcoded `variant="danger"` in the test, so flipping the
// caller to "default" kept it green — it pinned ConfirmModal's behaviour,
// not the caller's use of it, which is the thing that was broken.
  function renderDialog(reason: 'dirty' | 'pending' = 'dirty') {
    render(
      <ConfirmModal
        isOpen
        {...paneCloseConfirmationProps(reason)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  test('the discarding action is not styled like the safe one', () => {
    renderDialog();
    const close = screen.getByRole('button', { name: 'Close pane' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });

// The whole point: they must not look the same. The hand-rolled pair
// carried no classes at all, so this comparison was trivially equal.
    expect(close.className).not.toBe(cancel.className);
    expect(close.className).toContain('danger');
  });

  test('it announces as an alertdialog, not a plain dialog', () => {
// ARIA distinguishes them and assistive tech announces them differently:
// `alertdialog` interrupts to guard something the user must act on.
// The hand-rolled markup had this right; reusing ConfirmModal silently
// downgraded it to `dialog`, and only the pane host's own suite caught
// it — after this file had already passed (archive#3157).
    renderDialog();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('it renders on a real dialog surface', () => {
    renderDialog();
// `--danger` on the panel is what carries the surface and the tone; the
// bespoke <section> had neither, so the prompt floated in normal flow.
// The panel class moved with ConfirmModal onto the shared `Dialog`
// the variant modifier it carries is unchanged.
    expect(document.querySelector('.station-dialog--danger')).toBeTruthy();
  });

  test('it still says which condition it is guarding', () => {
    renderDialog();
    expect(screen.getByText('This pane has unsaved changes.')).toBeTruthy();
  });
});

describe('the caller asks for the destructive treatment', () => {
  test('both close reasons are destructive, because both discard work', () => {
// Pending work is lost the same way unsaved work is, so the danger
// treatment is unconditional rather than dirty-only.
    expect(paneCloseConfirmationProps('dirty').variant).toBe('danger');
    expect(paneCloseConfirmationProps('pending').variant).toBe('danger');
    expect(paneCloseConfirmationProps(undefined).variant).toBe('danger');
  });

  test('the caller asks for that role, not just this fixture', () => {
    expect(paneCloseConfirmationProps('dirty').role).toBe('alertdialog');
  });

  test('the message names which condition triggered it', () => {
    expect(paneCloseConfirmationProps('dirty').message).toContain(
      'unsaved changes',
    );
    expect(paneCloseConfirmationProps('pending').message).toContain(
      'pending work',
    );
  });
});
