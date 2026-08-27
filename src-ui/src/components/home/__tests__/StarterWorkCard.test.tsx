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
