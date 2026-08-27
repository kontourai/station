/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isRelevantRoot, RootPicker } from '../RootPicker';

const allRoots = [
  {
    id: 'root:personal',
    scope: { kind: 'personal' },
    displayName: 'Personal',
    adapterId: 'kit-default-store',
    storeRoot: '/personal',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'root:project-a',
    scope: { kind: 'project', projectSlug: 'project-a' },
    displayName: 'Project A',
    adapterId: 'kit-default-store',
    storeRoot: '/project-a',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'root:project-b',
    scope: { kind: 'project', projectSlug: 'project-b' },
    displayName: 'Project B',
    adapterId: 'kit-default-store',
    storeRoot: '/project-b',
    createdAt: '2026-01-01T00:00:00Z',
  },
] as const;

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof RootPicker>> = {},
) {
  const props: React.ComponentProps<typeof RootPicker> = {
    roots: allRoots.filter((root) => isRelevantRoot(root, 'project-a')),
    isLoading: false,
    error: null,
    value: null,
    onChange: vi.fn(),
    onRetry: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  return { ...render(<RootPicker {...props} />), props };
}

describe('RootPicker', () => {
  afterEach(cleanup);

  test('shows only roots supplied by the authority-owning parent', () => {
    const { props } = renderPicker();
    expect(screen.getByText('Personal (personal)')).toBeTruthy();
    expect(screen.getByText('Project A (project)')).toBeTruthy();
    expect(screen.queryByText('Project B (project)')).toBeNull();

    fireEvent.change(screen.getByTestId('kl-root-select'), {
      target: { value: 'root:project-a' },
    });
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'root:project-a' }),
    );
  });

  test('offers setup navigation when no relevant root exists', () => {
    const { props } = renderPicker({ roots: [] });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open knowledge settings' }),
    );
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
  });

  test('does not turn a root request failure into an empty state', () => {
    renderPicker({ error: new Error('root service unavailable') });
    expect(screen.getByRole('alert').textContent).toContain(
      'root service unavailable',
    );
    expect(screen.queryByText('No relevant Knowledge Kit root')).toBeNull();
  });
});
