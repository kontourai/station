/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Dialog } from '../components/Dialog';

const INDEX_CSS = readFileSync(
  join(import.meta.dirname, '..', 'index.css'),
  'utf8',
);

describe('Dialog — the one Station dialog chrome (SHELL-02)', () => {
  test('renders eyebrow, title, subtitle, close X, body and footer in one contract', () => {
    const { container } = render(
      <Dialog
        eyebrow="Project setup"
        title="New Project"
        subtitle="Point Station at a directory."
        closeLabel="Close new project"
        onClose={vi.fn()}
        footer={<button type="button">Create</button>}
      >
        <p>body</p>
      </Dialog>,
    );

    expect(screen.getByText('Project setup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New Project' })).toBeTruthy();
    expect(screen.getByText('Point Station at a directory.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Close new project' }),
    ).toBeTruthy();
    expect(container.querySelector('.station-dialog__body')).toBeTruthy();
    expect(container.querySelector('.station-dialog__footer')).toBeTruthy();
  });

  test('the title names the dialog for assistive tech', () => {
    render(
      <Dialog
        title="Delete Job"
        closeLabel="Close delete job"
        onClose={vi.fn()}
      >
        <p>body</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe(
      'Delete Job',
    );
  });

  test('every dialog gets a close X — Delete Job was the one that did not', () => {
    const onClose = vi.fn();
    render(
      <Dialog
        title="Delete Job"
        closeLabel="Close delete job"
        onClose={onClose}
      >
        <p>body</p>
      </Dialog>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close delete job' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The `.responsive-dialog-header` incident, generalised: chrome defined in a
   * lazily imported stylesheet renders unstyled for whichever consumer opens
   * first, which is the one time it matters. `Dialog` is imported by dialogs
   * that live in lazy chunks, so its styles must be in the eager sheet.
   */
  test('the chrome is defined in the eagerly loaded index.css', () => {
    for (const selector of [
      '.station-dialog {',
      '.station-dialog__header {',
      '.station-dialog__body {',
      '.station-dialog__footer {',
      '.station-dialog__eyebrow {',
      '.station-dialog__overlay {',
    ]) {
      expect(INDEX_CSS, `${selector} must be in index.css`).toContain(selector);
    }
  });

  test('the body scrolls, so a long form can never push its commit action below the fold', () => {
    const body = INDEX_CSS.slice(
      INDEX_CSS.indexOf('.station-dialog__body {'),
      INDEX_CSS.indexOf('}', INDEX_CSS.indexOf('.station-dialog__body {')),
    );
    expect(body).toContain('overflow-y: auto');
    expect(body).toContain('min-height: 0');
  });
});
