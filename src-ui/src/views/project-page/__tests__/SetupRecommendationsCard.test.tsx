/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const flags = new Set<string>();
const createTask = vi.fn();
const createReference = vi.fn();
const updateProject = vi.fn();
let tasks: { id: string }[] = [];

vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags,
}));
vi.mock('@kontourai/station-sdk', () => ({
  taskQueries: { list: (slug: string) => ({ queryKey: ['tasks', slug] }) },
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }),
  useTasksQuery: () => ({ isSuccess: true, data: tasks }),
  useCreateTaskMutation: () => ({ mutateAsync: createTask }),
  useCreateTaskReferenceMutation: () => ({ mutateAsync: createReference }),
  useUpdateProjectMutation: () => ({ mutateAsync: updateProject }),
}));

import { rememberPendingContinuation } from '../../../lib/continue-in-project';
import { SetupRecommendationsCard } from '../SetupRecommendationsCard';

const project = { id: 'p-1', slug: 'billing', name: 'Billing' };

beforeEach(() => {
  flags.clear();
  flags.add('continue-in-project');
  tasks = [];
  localStorage.clear();
  sessionStorage.clear();
  createTask.mockReset().mockResolvedValue({ id: 'task-1' });
  createReference.mockReset().mockResolvedValue({});
  updateProject.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('SetupRecommendationsCard', () => {
  test('nothing is created until Apply, and only what is still on', async () => {
    render(<SetupRecommendationsCard project={project} hasRepository />);
    const explore = screen.getByRole('checkbox', {
      name: /New Task: Explore and propose next steps/,
    });
    const brief = screen.getByRole('checkbox', { name: /Brief/ });
    expect(explore).toHaveProperty('checked', true);
    expect(brief).toHaveProperty('checked', true);
    expect(createTask).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();

    fireEvent.click(brief);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'billing',
        title: 'Explore and propose next steps',
      }),
    );
    expect(updateProject).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(screen.queryByText('Setup recommendations')).toBeNull(),
    );
    expect(localStorage.getItem('station.setup-recommendations.done.p-1')).toBe(
      'applied',
    );
  });

  test('a Project continued from a chat gets a Task citing that answer', async () => {
    rememberPendingContinuation({
      sessionId: 'session-1',
      turnId: 'turn-1',
      title: 'Continue: Revenue',
      description: 'Continued from the chat “Revenue”',
      savedAt: new Date().toISOString(),
    });
    render(
      <SetupRecommendationsCard
        project={{ ...project, description: 'Continued from the chat' }}
        hasRepository={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() =>
      expect(createReference).toHaveBeenCalledWith({
        taskId: 'task-1',
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
        sourceSurface: 'chat',
      }),
    );
    expect(sessionStorage.length).toBe(0);
  });

  test('a retry after a failure does not create the same Task twice', async () => {
    createReference.mockRejectedValueOnce(new Error('Station is busy'));
    rememberPendingContinuation({
      sessionId: 'session-1',
      turnId: 'turn-1',
      title: 'Continue: Revenue',
      description: 'brief',
      savedAt: new Date().toISOString(),
    });
    render(
      <SetupRecommendationsCard
        project={{ ...project, description: 'set' }}
        hasRepository
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/Setup didn't finish/);
    expect(createTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
    // Second Apply cites the Task it already created, then adds Explore.
    expect(createTask.mock.calls.map(([input]) => input.title)).toEqual([
      'Continue: Revenue',
      'Explore and propose next steps',
    ]);
    expect(createReference).toHaveBeenCalledTimes(2);
    expect(createReference.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ taskId: 'task-1', turnId: 'turn-1' }),
    );
  });

  test('hidden when the preview is off, the Project has Tasks, or it was dismissed', () => {
    flags.clear();
    const { unmount } = render(
      <SetupRecommendationsCard project={project} hasRepository />,
    );
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    unmount();

    flags.add('continue-in-project');
    tasks = [{ id: 'existing' }];
    const second = render(
      <SetupRecommendationsCard project={project} hasRepository />,
    );
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    second.unmount();

    tasks = [];
    render(<SetupRecommendationsCard project={project} hasRepository />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Setup recommendations')).toBeNull();
    expect(createTask).not.toHaveBeenCalled();
  });
});
