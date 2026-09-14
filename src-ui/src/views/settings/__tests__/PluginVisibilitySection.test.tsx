/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const usePluginVisibilityQuery = vi.fn();
const usePluginsQuery = vi.fn();
const mutate = vi.fn();
const isPluginVisibilityForbidden = vi.fn((_error: unknown) => false);

vi.mock('@kontourai/station-sdk', () => ({
  usePluginVisibilityQuery: () => usePluginVisibilityQuery(),
  usePluginsQuery: () => usePluginsQuery(),
  useSetPluginVisibilityMutation: () => ({
    mutate,
    isError: false,
    error: null,
  }),
  isPluginVisibilityForbidden: (error: unknown) =>
    isPluginVisibilityForbidden(error),
}));

const { PluginVisibilitySection } = await import('../PluginVisibilitySection');

const DIRECTORY = {
  principals: [
    {
      id: 'human:local:operator',
      display: 'Operator',
      revoked: false,
      plugins: [],
      operator: true,
    },
    {
      id: 'human:device:laptop',
      display: 'Collaborator',
      revoked: false,
      plugins: ['notes'],
      operator: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  isPluginVisibilityForbidden.mockReturnValue(false);
  usePluginVisibilityQuery.mockReturnValue({
    data: DIRECTORY,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  usePluginsQuery.mockReturnValue({
    data: [
      { name: 'notes', displayName: 'Notes' },
      { name: 'timers', displayName: 'Timers' },
    ],
    isLoading: false,
  });
});

test('the section renders nothing at all when the route refuses this caller', () => {
  // Not "renders an error": a collaborator has no grant surface, and a
  // Settings section explaining a capability they do not have is noise the
  // server has already refused.
  isPluginVisibilityForbidden.mockReturnValue(true);
  usePluginVisibilityQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error('forbidden'),
    refetch: vi.fn(),
  });
  const { container } = render(<PluginVisibilitySection />);
  expect(container.innerHTML).toBe('');
});

test('the operator has no grant row: they see everything by derivation', () => {
  render(<PluginVisibilitySection />);
  expect(screen.getByText('Collaborator')).toBeTruthy();
  // The operator's own row is filtered out. Rendering it with an empty set of
  // toggles would show a grant record that does not exist and invite an
  // operator to "grant themselves" a plugin they already see.
  expect(screen.queryByText('Operator')).toBeNull();
});

test('a toggle reflects the recorded grant and sends the change for that pair', () => {
  render(<PluginVisibilitySection />);
  const notes = screen.getByLabelText(
    'Share Notes with Collaborator',
  ) as HTMLInputElement;
  const timers = screen.getByLabelText(
    'Share Timers with Collaborator',
  ) as HTMLInputElement;
  expect(notes.checked).toBe(true);
  expect(timers.checked).toBe(false);

  fireEvent.click(timers);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0]?.[0]).toEqual({
    principalId: 'human:device:laptop',
    plugin: 'timers',
    grant: true,
  });

  fireEvent.click(notes);
  expect(mutate.mock.calls[1]?.[0]).toEqual({
    principalId: 'human:device:laptop',
    plugin: 'notes',
    grant: false,
  });
});

test('a revoked person stays listed so their grants can be removed', () => {
  usePluginVisibilityQuery.mockReturnValue({
    data: {
      principals: [
        {
          id: 'human:device:old',
          display: 'Retired laptop',
          revoked: true,
          plugins: ['notes'],
          operator: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<PluginVisibilitySection />);
  expect(screen.getByText('Retired laptop')).toBeTruthy();
  expect(
    (
      screen.getByLabelText(
        'Share Notes with Retired laptop',
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test('nobody paired yet is an empty state, not an error', () => {
  usePluginVisibilityQuery.mockReturnValue({
    data: { principals: [DIRECTORY.principals[0]] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  render(<PluginVisibilitySection />);
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
});

test('the chrome waits for the resolved state rather than flashing', () => {
  // #2067 L1. A non-operator used to see the heading and the intro paragraph
  // while the request was in flight, and then have them taken away. The
  // chrome is a claim about who the caller is, so it waits for the answer.
  usePluginVisibilityQuery.mockReturnValue({
    data: undefined,
    isLoading: true,
    isPending: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  const { container } = render(<PluginVisibilitySection />);
  expect(container.innerHTML).toBe('');
});

test('the operator still gets the section once the directory resolves', () => {
  // The control for the two "renders nothing" cases above: without it, a
  // component that returned null unconditionally would satisfy both.
  const { container } = render(<PluginVisibilitySection />);
  expect(container.innerHTML).not.toBe('');
  expect(screen.getByText('Plugin visibility')).toBeTruthy();
});
