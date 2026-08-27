/**
 * @vitest-environment jsdom
 */

import type { KitRegistryEntry } from '@kontourai/station-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

const enabledEntry: KitRegistryEntry = {
  contributionRef: 'knowledge/kit',
  lifecycle: 'installed' as const,
  incarnation: 2,
  experience: {
    status: 'enabled',
    diagnostics: [],
    standardViews: [],
  },
};

let entries = [enabledEntry];
let existingLayouts: Array<{ slug: string }> = [];
let projectLayoutsLoading = false;
let projectLayoutsError: Error | undefined;

vi.mock('@kontourai/station-sdk', () => ({
  canMaterializeKitProjectLayout: (entry: typeof enabledEntry) =>
    entry.lifecycle === 'installed' && entry.experience.status === 'enabled',
  materializeKitProjectLayout: (entry: typeof enabledEntry) => ({
    slug: `kit-${entry.incarnation}`,
    name: `Kit: ${entry.contributionRef}`,
    description: 'Read-only portable Kit projection hosted by Station.',
    type: 'kit-observability',
    config: { tabs: [] },
  }),
  useCreateProjectLayoutMutation: () => ({
    isPending: false,
    mutate: sdk.mutate,
  }),
  useKitLayoutQuery: () => ({
    data: {
      component: {
        kind: 'mcp-tool-ui',
        ref: 'knowledge/read',
        approvalPolicy: 'read-only',
      },
      standardViews: [],
    },
    isLoading: false,
  }),
  useKitRegistryQuery: () => ({ data: entries, isLoading: false }),
  useProjectLayoutsQuery: () => ({
    data: existingLayouts,
    isLoading: projectLayoutsLoading,
    error: projectLayoutsError,
  }),
  useProjectsQuery: () => ({
    data: [{ slug: 'demo', name: 'Demo project' }],
    isLoading: false,
  }),
}));

const setLayout = vi.fn();
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setLayout }),
}));

import { KitCatalog } from '../KitCatalog';

afterEach(() => {
  entries = [enabledEntry];
  existingLayouts = [];
  projectLayoutsLoading = false;
  projectLayoutsError = undefined;
  sdk.mutate.mockReset();
  setLayout.mockReset();
});

describe('KitCatalog', () => {
  test('uses labeled controls to materialize an enabled read-only Kit into the selected project', () => {
    render(<KitCatalog />);

    expect(
      screen.getByText(
        'MCP app view available through Station’s hardened frame.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'View knowledge/kit details' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.change(screen.getByLabelText('Apply to project'), {
      target: { value: 'demo' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add read-only layout' }),
    );

    expect(sdk.mutate).toHaveBeenCalledWith({
      projectSlug: 'demo',
      slug: 'kit-2',
      name: 'Kit: knowledge/kit',
      description: 'Read-only portable Kit projection hosted by Station.',
      type: 'kit-observability',
      config: { tabs: [] },
    });
  });

  test('fails closed while the duplicate check is loading or unavailable', () => {
    projectLayoutsLoading = true;
    const { rerender } = render(<KitCatalog />);

    fireEvent.change(screen.getByLabelText('Apply to project'), {
      target: { value: 'demo' },
    });
    expect(
      screen.getByRole('button', { name: 'Checking project layouts...' }),
    ).toHaveProperty('disabled', true);

    projectLayoutsLoading = false;
    projectLayoutsError = new Error('offline');
    rerender(<KitCatalog />);
    expect(
      screen.getByRole('button', { name: 'Project layout check required' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('offline');
  });

  test('keeps a disabled Kit visible, diagnosed, and non-mutating', () => {
    entries = [
      {
        ...enabledEntry,
        lifecycle: 'disabled' as const,
        experience: {
          ...enabledEntry.experience,
          status: 'disabled',
          diagnostics: [
            { code: 'host_disabled', message: 'Station disabled this Kit.' },
          ],
        },
      },
    ];
    render(<KitCatalog />);

    expect(screen.getAllByText('Disabled')).toHaveLength(2);
    expect(screen.getByText('Station disabled this Kit.')).toBeTruthy();
    expect(
      screen.getByText('This Kit is listed here, but it isn’t installed.'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Add read-only layout' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(sdk.mutate).not.toHaveBeenCalled();
  });

  test('refuses to overwrite a project layout already materialized for this Kit incarnation', () => {
    existingLayouts = [{ slug: 'kit-2' }];
    render(<KitCatalog />);

    fireEvent.change(screen.getByLabelText('Apply to project'), {
      target: { value: 'demo' },
    });
    const button = screen.getByRole('button', { name: 'Already added' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(sdk.mutate).not.toHaveBeenCalled();
  });
});
