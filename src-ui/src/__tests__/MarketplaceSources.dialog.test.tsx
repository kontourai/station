/** @vitest-environment jsdom */
// The add-source result with the REAL Dialog (focus containment and all), not
// the mock the component tests use.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MarketplaceSources } from '../components/registry/MarketplaceSources';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  useRegistrySourcesQuery: () => ({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRegistrySourceActionMutation: () => ({
    mutate,
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
afterEach(() => vi.clearAllMocks());

const added = {
  id: 'added',
  kind: 'skills',
  displayName: 'Example skill collection',
  origin: 'user',
  location: '/sources/example',
  adapter: 'directory',
  enabled: true,
  status: 'ready',
  detection: {
    state: 'detected',
    checkedAt: '2026-11-12T00:00:00.000Z',
    kinds: [{ kind: 'skills', count: 3, via: 'skill-md', installable: true }],
  },
};

test('with the real dialog, the result takes focus inside the panel, is announced, and Tab stays in the dialog', () => {
  render(<MarketplaceSources selected="all" onSelect={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  const form = screen.getByRole('dialog', { name: 'Add source' });
  fireEvent.change(within(form).getByLabelText('Location'), {
    target: { value: '/sources/example' },
  });
  const submit = within(form)
    .getAllByRole('button', { name: 'Add source' })
    .at(-1)!;
  submit.focus();
  fireEvent.click(submit);
  const { onSuccess } = mutate.mock.calls.at(-1)![1] as {
    onSuccess: (source: unknown) => void;
  };
  act(() => onSuccess(added));

  const dialog = screen.getByRole('dialog', {
    name: 'Added Example skill collection',
  });
  const focused = document.activeElement as HTMLElement;
  expect(focused).not.toBe(document.body);
  expect(dialog.contains(focused)).toBe(true);
  expect(focused.textContent).toBe('Station read this source and found:');
  expect(focused.closest('[role="status"], [aria-live]')).not.toBeNull();

  // Containment: Tab from the last control wraps inside the dialog.
  const controls = within(dialog).getAllByRole('button');
  controls.at(-1)!.focus();
  fireEvent.keyDown(controls.at(-1)!, { key: 'Tab' });
  expect(dialog.contains(document.activeElement)).toBe(true);
});
