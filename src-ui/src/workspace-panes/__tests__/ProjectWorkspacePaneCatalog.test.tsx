/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProjectWorkspacePaneSection } from '../ProjectWorkspacePaneCatalog';
import type { ResolvedWorkspacePaneCatalogEntry } from '../resolvedWorkspacePaneCatalog';

function resolvedEntry(
  name: string,
  options: { placed?: boolean; available?: boolean } = {},
): ResolvedWorkspacePaneCatalogEntry {
  const { placed = true, available = true } = options;
  return {
    descriptor: {
      id: `pane.${name.toLowerCase()}`,
      name,
      description: `${name} description`,
    },
    ...(placed
      ? { instance: { instanceId: `instance.${name.toLowerCase()}` } }
      : {}),
    availability: available
      ? { state: 'available', reason: { code: 'ready', source: 'resolver' } }
      : {
          state: 'not-configured',
          reason: { code: 'missing-project', source: 'context' },
          action: { type: 'setup', code: 'select-project' },
        },
    clientRendererPresence: 'present',
  } as never;
}

function renderSection(
  entries: ResolvedWorkspacePaneCatalogEntry[],
  overrides: Partial<Parameters<typeof ProjectWorkspacePaneSection>[0]> = {},
) {
  const props = {
    entries,
    loading: false,
    error: false,
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    onAction: vi.fn(),
    canExecuteAction: () => true,
    onOpen: vi.fn(),
    embedded: true,
    ...overrides,
  };
  render(<ProjectWorkspacePaneSection {...props} />);
  return props;
}

// station#3318: the project page's pane section is an active-pane inventory,
// not an availability diagnostics list — unplaced descriptors live only in the
// Add-pane picker.
describe('ProjectWorkspacePaneSection (station#3318)', () => {
  test('shows only active (placed) panes, never unplaced catalog entries', () => {
    renderSection([
      resolvedEntry('Files', { placed: true }),
      resolvedEntry('Preview', { placed: false }),
    ]);

    expect(screen.getByText('Files')).toBeTruthy();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  test('with no active panes, offers the Add pane affordance instead of diagnostics', () => {
    const props = renderSection([resolvedEntry('Preview', { placed: false })]);

    expect(screen.queryByText('Preview')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add pane' });
    fireEvent.click(add);
    expect(props.onOpen).toHaveBeenCalled();
  });

  test('an active pane that is currently unavailable keeps its truthful state badge', () => {
    renderSection([resolvedEntry('Files', { placed: true, available: false })]);

    expect(
      screen.getByRole('button', { name: 'Files Setup needed' }),
    ).toBeTruthy();
  });
});
