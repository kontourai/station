/** @vitest-environment jsdom */

import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-file-preview';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { createFilePreviewPaneInstance } from '../filePreviewPaneInstance';
import { ProjectWorkspacePaneModal } from '../ProjectWorkspacePaneCatalog';
import type { ResolvedWorkspacePaneCatalogEntry } from '../resolvedWorkspacePaneCatalog';

const preview = createFilePreviewPaneInstance(
  {
    version: '1.0',
    projectSlug: 'project-route',
    path: 'src/pickable.ts',
    wrap: true,
  },
  'project-uuid',
  'd'.repeat(32),
)!;

const entries: readonly ResolvedWorkspacePaneCatalogEntry[] = [
  {
    instance: preview,
    availability: {
      state: 'available',
      reason: { code: 'ready', source: 'resolver' },
    },
    descriptor: WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
    clientRendererPresence: 'present',
  },
];

function renderModal(notice?: string | null, onClose = vi.fn()) {
  render(
    <ProjectWorkspacePaneModal
      show
      onClose={onClose}
      entries={entries}
      loading={false}
      error={false}
      onRetry={vi.fn()}
      onSelect={vi.fn()}
      onAction={vi.fn(() => '')}
      canExecuteAction={vi.fn(() => false)}
      notice={notice}
    />,
  );
  return onClose;
}

test('carries an open refusal in the sanctioned callout primitive, above a still-usable list', () => {
  renderModal('That pane is already open in this workspace.');
  const dialog = screen.getByRole('dialog', { name: 'Add workspace pane' });
  // `alert`, not `status`: the callout is mounted BY the click it answers, and
  // a polite live region inserted already holding its text is not reliably
  // announced — a screen-reader user would get the same "nothing happened"
  // #1596 exists to close.
  const callout = within(dialog).getByRole('alert', {
    name: 'Workspace pane could not open',
  });
  expect(callout.getAttribute('role')).toBe('alert');
  expect(
    within(dialog).queryByRole('status', {
      name: 'Workspace pane could not open',
    }),
  ).toBeNull();
  // The shared page-callout primitive, not bespoke copy markup: the
  // state-primitives family owns this shape (#192) and `data-callout-id` is
  // how it identifies itself.
  expect(callout.getAttribute('data-callout-id')).toBe(
    'workspace-pane-open-refused',
  );
  expect(callout.textContent).toContain(
    'That pane is already open in this workspace.',
  );
  // The reason does not replace the picker: its list and its Open control are
  // still there to try again with.
  expect(
    within(dialog).getByRole('list', { name: 'Workspace panes' }),
  ).toBeTruthy();
  expect(
    within(dialog)
      .getByRole('button', { name: 'Open File Preview' })
      .hasAttribute('disabled'),
  ).toBe(false);
});

test('shows no callout when the picker has refused nothing', () => {
  renderModal(null);
  const dialog = screen.getByRole('dialog', { name: 'Add workspace pane' });
  expect(
    within(dialog).queryByRole('alert', {
      name: 'Workspace pane could not open',
    }),
  ).toBeNull();
});

// Three ways out, none of them observed before this file existed in this shape
// (#1616). The picker no longer owns any of the mechanisms — `Dialog` and
// `ResponsiveDialogSurface` below it do — which is exactly why the picker's own
// tests should say the picker still HAS them: a props rename or a swapped
// primitive is a silent regression otherwise.
test('Escape inside the picker closes it', () => {
  const onClose = renderModal(null);
  const dialog = screen.getByRole('dialog', { name: 'Add workspace pane' });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('the close control closes the picker', () => {
  const onClose = renderModal(null);
  fireEvent.click(screen.getByRole('button', { name: 'Close pane picker' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Cancel closes the picker', () => {
  const onClose = renderModal(null);
  const dialog = screen.getByRole('dialog', { name: 'Add workspace pane' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

function renderCatalog(error: boolean, onRetry = vi.fn()) {
  render(
    <ProjectWorkspacePaneModal
      show
      onClose={vi.fn()}
      entries={entries}
      loading={false}
      error={error}
      onRetry={onRetry}
      onSelect={vi.fn()}
      onAction={vi.fn(() => '')}
      canExecuteAction={vi.fn(() => false)}
    />,
  );
  return onRetry;
}

test('marks a cached list whose background refresh failed, with Retry, and keeps the list usable (#2345)', () => {
  const onRetry = renderCatalog(true);
  const dialog = screen.getByRole('dialog', { name: 'Add workspace pane' });
  const marker = within(dialog).getByRole('status', {
    name: 'Pane list not refreshed',
  });
  expect(marker.getAttribute('data-callout-id')).toBe(
    'workspace-pane-catalog-refresh-failed',
  );
  expect(marker.textContent).toContain('Couldn’t refresh the pane list');
  // The cached answer is still the list, not an error screen.
  expect(
    within(dialog).getByRole('list', { name: 'Workspace panes' }),
  ).toBeTruthy();
  expect(
    within(dialog).queryByText('Could not load workspace panes'),
  ).toBeNull();
  fireEvent.click(within(marker).getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('shows no refresh marker when the list is current (#2345)', () => {
  renderCatalog(false);
  expect(
    screen.queryByRole('status', { name: 'Pane list not refreshed' }),
  ).toBeNull();
});
