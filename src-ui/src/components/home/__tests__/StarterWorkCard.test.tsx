/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, useStarterWorkQuery, useTaskQuery } = vi.hoisted(() => ({
  navigate: vi.fn(),
  useStarterWorkQuery: vi.fn(),
  useTaskQuery: vi.fn(),
}));
let projects: Array<{ slug: string; name?: string }> = [];

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects, isLoading: false }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useStarterWorkQuery,
  useTaskQuery,
}));

import { StarterWorkCard } from '../StarterWorkCard';

describe('StarterWorkCard', () => {
  beforeEach(() => {
    projects = [];
    navigate.mockReset();
    useStarterWorkQuery.mockReset().mockReturnValue({
      data: { state: 'unbound' },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    useTaskQuery.mockReset().mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  it('does not offer a task without a real Project', async () => {
    render(<StarterWorkCard />);
    expect(screen.queryByTestId('starter-work-card')).toBeNull();
  });

  it('opens existing task creation with bounded starter context', async () => {
    projects = [{ slug: 'alpha', name: 'Alpha' }];
    render(<StarterWorkCard />);
    await screen.findByText('Start your first task');
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(navigate).toHaveBeenCalledWith('/projects/alpha', {
      starter: 'start-task',
    });
  });

  it('fills the pending card with the canonical shimmer instead of an empty outline', () => {
    projects = [{ slug: 'alpha', name: 'Alpha' }];
    useStarterWorkQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    const { container } = render(<StarterWorkCard />);

    const card = screen.getByLabelText('Starter work');
    // #1582 C4: the shimmer's flex sizing hangs off the shared primitive's
    // busy modifier now (`.page-callout--busy .skeleton-block`), which is
    // what stops the block collapsing to nothing inside a flex row.
    expect(card.classList.contains('page-callout--busy')).toBe(true);
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(
      screen.getByRole('status', { name: 'Checking starter work' }),
    ).toBeTruthy();
    expect(container.querySelector('.skeleton--block')).toBeTruthy();
  });

  it('#1582 C4: an unreachable ledger reads as a warning, with its copy unchanged', () => {
    // The offer and its failure are the SAME callout — one identity, so a
    // stack can never show both — but not the same tone: an offer is `info`,
    // a ledger Station cannot reach is `warning`, which is the banner scale's
    // own word for it.
    projects = [{ slug: 'alpha', name: 'Alpha' }];
    const refetch = vi.fn();
    useStarterWorkQuery.mockReturnValue({
      data: { state: 'unavailable' },
      isLoading: false,
      isError: false,
      refetch,
    });
    render(<StarterWorkCard />);

    const card = screen.getByLabelText('Starter work');
    expect(card.getAttribute('data-callout-id')).toBe('starter-work');
    expect(card.className).toContain('page-callout--warning');
    expect(card.textContent).toContain('Starter Work is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('reopens only the exact bound Task', async () => {
    projects = [{ slug: 'alpha', name: 'Alpha' }];
    useStarterWorkQuery.mockReturnValue({
      data: {
        state: 'bound',
        binding: {
          targetRef: { kind: 'task', id: 'task/exact', projectId: 'alpha' },
        },
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    useTaskQuery.mockReturnValue({
      data: { id: 'task/exact' },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<StarterWorkCard />);
    await waitFor(() =>
      expect(screen.getByText('Your first task is ready')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(navigate).toHaveBeenCalledWith('/tasks/task%2Fexact');
  });
});
