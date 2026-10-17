/**
 * @vitest-environment jsdom
 */
import type { GitStatusResult } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const { createTask, launchStarterTask, navigate, gitStatusQuery } = vi.hoisted(
  () => ({
    createTask: vi.fn(),
    launchStarterTask: vi.fn(),
    navigate: vi.fn(),
    gitStatusQuery: vi.fn(),
  }),
);
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../views/project-page/ProjectTaskSharingControl', () => ({
  ProjectTaskSharingControl: () => null,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useProjectQuery: () => ({
    data: {
      id: 'project-demo',
      workingDirectory: '/workspace/demo',
      agents: ['planner'],
    },
  }),
  useGitStatusQuery: gitStatusQuery,
  useTasksQuery: () => ({ data: [], refetch: vi.fn() }),
  useTaskGraphQuery: () => ({}),
  useTaskClaimQuery: () => ({}),
  useWorkItemClaimQuery: () => ({}),
  useWorkflowTasksQuery: () => ({ data: [] }),
  useWorkItemsQuery: () => ({}),
  useCreateTaskMutation: () => ({ mutateAsync: createTask }),
  useDispatchTaskMutation: () => ({}),
  useLaunchStartTaskStarterMutation: () => ({ mutateAsync: launchStarterTask }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
  taskQueries: {
    list: (slug: string) => ({ queryKey: ['tasks', slug] }),
    graph: (id: string) => ({ queryKey: ['task-graph', id] }),
  },
}));

import { TasksLayout } from '../components/TasksLayout';

test('creates a Starter Task from the board with the Project workspace and git binding', async () => {
  window.history.replaceState({}, '', '/projects/demo?starter=start-task');
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T,>(
        _name: string,
        _options: { mode: 'exclusive' },
        callback: () => Promise<T>,
      ): Promise<T> => callback(),
    },
  });
  const gitStatus: GitStatusResult = {
    isRepo: true,
    repoRoot: '/workspace/demo',
    branch: 'feature/task',
    changes: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    lastCommit: null,
  };
  gitStatusQuery.mockReturnValue({ data: gitStatus });
  launchStarterTask.mockResolvedValue({
    state: 'started',
    task: { id: 'task-new' },
    correlation: { state: 'bound', binding: {} },
    dispatch: { state: 'dispatched' },
  });
  render(<TasksLayout projectSlug="demo" layoutSlug="tasks" config={{}} />);
  expect(
    screen.getByText(/Follow the work by its recorded status/),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), {
    target: { value: 'Board Task' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
  await waitFor(() =>
    expect(launchStarterTask).toHaveBeenCalledExactlyOnceWith({
      starterId: 'start-task',
      operationId: expect.any(String),
      task: {
        projectId: 'demo',
        title: 'Board Task',
        agentId: 'planner',
        createdBy: 'user',
        workspaceBinding: {
          workingDirectory: '/workspace/demo',
          repoRoot: '/workspace/demo',
          worktreePath: '/workspace/demo',
          branch: 'feature/task',
          sourceSurface: 'ui',
        },
      },
      dispatch: {
        agentId: 'planner',
        runtimeConfig: { cwd: '/workspace/demo' },
      },
    }),
  );
  expect(gitStatusQuery).toHaveBeenCalledWith({
    projectSlug: 'demo',
    workingDir: '/workspace/demo',
  });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-new'));
  expect(createTask).not.toHaveBeenCalled();
  window.history.replaceState({}, '', '/');
});
