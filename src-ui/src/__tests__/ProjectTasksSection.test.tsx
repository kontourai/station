/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  navigate,
  showToast,
  useWorkflowTasksQuery,
  useWorkItemsQuery,
  useTasksQuery,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  showToast: vi.fn(),
  useWorkflowTasksQuery: vi.fn(),
  useWorkItemsQuery: vi.fn(),
  useTasksQuery: vi.fn(),
}));
const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
const createTask = vi.fn();
const dispatchTask = vi.fn();
const launchStarterTask = vi.fn();
const refetchTasks = vi.fn();
const starterWorkLock = {
  request: async <T,>(
    _name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T> => callback(),
};
// `= []` alone makes a failed `useTasksQuery` read indistinguishable
// from a project with no tasks — both the task list AND the detail pane
// claimed "No tasks yet." / "Select a task." over a read that never answered.
let tasksError: unknown;
let tasks: Array<{
  id: string;
  projectId: string;
  title: string;
  priority: 'normal';
  status: 'todo' | 'ready';
  createdAt: string;
  updatedAt: string;
  description: string;
  createdBy: string;
  agentId?: string;
  sessionId?: string;
  workspaceBinding?: {
    workingDirectory?: string;
    repoRoot?: string;
    worktreePath?: string;
    branch?: string;
  };
  workItemRef?: string;
}>;
let workflowTasks: Array<{
  taskSlug: string;
  status: string;
  phase: string;
  updatedAt: string;
  nextAction: { status: string; summary: string };
  hasHandoff: boolean;
  path: string;
  flowRun?: {
    current_step: string;
    open_gate_ids: string[];
  };
}> = [];
let workItemsData: {
  providers: Array<{
    identity: { kind: string; id: string; label: string };
    capabilities: {
      readOnly: boolean;
      supportsDispatch: boolean;
      supportsStatusWrite: boolean;
    };
    available: boolean;
    items: Array<{
      id: string;
      title: string;
      status: string;
      provider: { kind: string; id: string; label: string };
      workItemRef?: string;
      url?: string;
    }>;
    warnings?: string[];
    reason?: string;
  }>;
} = { providers: [] };
// Roadmap archive#584, part of epic archive#580, S4: AssignmentProvider claim state.
let taskClaim: {
  state: string;
  actor?: {
    runtime: string;
    sessionId: string;
    host: string;
    human?: string | null;
  };
} = { state: 'none' };
let providerItemClaim: {
  state: string;
  actor?: {
    runtime: string;
    sessionId: string;
    host: string;
    human?: string | null;
  };
} = { state: 'free' };
let navigationEffect: ((pathname: string) => void) | undefined;

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: (pathname: string, params?: Record<string, string | null>) => {
      if (params === undefined) navigate(pathname);
      else navigate(pathname, params);
      navigationEffect?.(pathname);
    },
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  toastStore: { show: showToast },
}));

vi.mock('@kontourai/station-sdk', () => ({
  taskQueries: {
    list: (projectId?: string) => ({ queryKey: ['tasks', projectId ?? 'all'] }),
    graph: (taskId: string) => ({ queryKey: ['task-graph', taskId] }),
  },
  useQueryClient: () => ({ invalidateQueries, setQueryData }),
  useTasksQuery,
  useTaskGraphQuery: (taskId: string) => ({
    data: taskId
      ? {
          links: [
            {
              id: 'link-1',
              targetType: 'session',
              targetId: 'task-task-1-1',
              relationType: 'spawned_session',
            },
          ],
        }
      : undefined,
  }),
  useCreateTaskMutation: () => ({
    isPending: false,
    mutateAsync: createTask,
  }),
  useDispatchTaskMutation: () => ({
    isPending: false,
    mutateAsync: dispatchTask,
  }),
  useLaunchStartTaskStarterMutation: () => ({
    isPending: false,
    mutateAsync: launchStarterTask,
  }),
  useWorkflowTasksQuery,
  useWorkItemsQuery,
  useTaskClaimQuery: () => ({ data: taskClaim }),
  useWorkItemClaimQuery: () => ({ data: providerItemClaim }),
}));

import { ProjectTasksSection } from '../views/project-page/ProjectTasksSection';

describe('ProjectTasksSection', () => {
  beforeEach(() => {
    invalidateQueries.mockReset();
    setQueryData.mockReset();
    createTask.mockReset();
    dispatchTask.mockReset();
    launchStarterTask.mockReset();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: starterWorkLock,
    });
    window.history.replaceState({}, '', '/');
    navigate.mockReset();
    navigationEffect = undefined;
    showToast.mockReset();
    refetchTasks.mockReset();
    tasksError = undefined;
    useTasksQuery.mockReset();
    useTasksQuery.mockImplementation(() => ({
      data: tasks,
      error: tasksError,
      refetch: refetchTasks,
    }));
    useWorkflowTasksQuery.mockReset();
    useWorkflowTasksQuery.mockImplementation(() => ({ data: workflowTasks }));
    useWorkItemsQuery.mockReset();
    useWorkItemsQuery.mockImplementation(() => ({ data: workItemsData }));
    tasks = [
      {
        id: 'task-1',
        projectId: 'project-alpha',
        title: 'Existing task',
        priority: 'normal',
        status: 'todo',
        description: '',
        createdBy: 'user',
        agentId: 'agent-one',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
    ];
    workflowTasks = [];
    workItemsData = { providers: [] };
    taskClaim = { state: 'none' };
    providerItemClaim = { state: 'free' };
  });

  test('does not query workspace-only sidecars for a project without a local workspace', () => {
    render(<ProjectTasksSection slug="project-alpha" />);

    expect(useWorkflowTasksQuery).toHaveBeenCalledWith('project-alpha', {
      enabled: false,
    });
    expect(useWorkItemsQuery).toHaveBeenCalledWith('project-alpha', {
      enabled: false,
    });
  });

  test('starter-link recovery is locked to the canonical Button primitive', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src-ui/src/views/TaskWorkspaceView.tsx'),
      'utf8',
    );
    const retry = source.slice(
      source.indexOf('function StarterLinkRetry'),
      source.indexOf('function taskReferences'),
    );
    expect(retry).toContain('<Button');
    expect(retry).not.toContain('editor-btn');
  });

  test('separates an indeterminate starter dispatch from correlation repair', async () => {
    window.history.pushState(
      {},
      '',
      '/projects/project-alpha?starter=start-task',
    );
    launchStarterTask.mockResolvedValue({
      state: 'started',
      task: { id: 'task-2', projectId: 'project-alpha' },
      correlation: {
        state: 'bound',
        binding: { starterId: 'start-task', operationId: 'op', targetRef: {} },
      },
      dispatch: {
        state: 'indeterminate',
        reason: 'response lost',
        retrySafe: false,
      },
      evidence: { state: 'NOT_VERIFIED', reason: 'unknown' },
    });
    render(<ProjectTasksSection slug="project-alpha" />);
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    // archive#3965: plain language now, but the two facts it must carry are
    // unchanged — the task EXISTS, and whether the agent picked it up is
    // unknown, so the reader must look before starting it again.
    expect(
      await screen.findByText(/couldn’t tell whether the agent started/i),
    ).toBeTruthy();
    expect(screen.getByText(/Your task was created/i)).toBeTruthy();
    expect(screen.getByText(/see before starting it again/i)).toBeTruthy();
    window.history.pushState({}, '', '/');
  });

  test('keeps the exact launch operation across response loss and remount', async () => {
    window.history.pushState(
      {},
      '',
      '/projects/project-alpha?starter=start-task',
    );
    launchStarterTask
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        state: 'deferred',
        reason: 'Agent engine is starting.',
        retrySafe: true,
      });
    const first = render(<ProjectTasksSection slug="project-alpha" />);
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(await screen.findByText(/response lost/i)).toBeTruthy();
    const operationId = launchStarterTask.mock.calls[0][0].operationId;
    first.unmount();

    render(<ProjectTasksSection slug="project-alpha" />);
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(
      await screen.findByText(/Waiting for the agent to be ready/i),
    ).toBeTruthy();
    expect(launchStarterTask.mock.calls[1][0].operationId).toBe(operationId);
  });

  test('does not launch when Starter Work retry state is corrupt', async () => {
    window.history.pushState(
      {},
      '',
      '/projects/project-alpha?starter=start-task',
    );
    window.localStorage.setItem('station-starter-work-operations-v1', '{bad');
    render(<ProjectTasksSection slug="project-alpha" />);

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    expect(
      await screen.findByText(
        /Nothing was started\. This device’s saved record of your first-task setup can’t be read/,
      ),
    ).toBeTruthy();
    expect(launchStarterTask).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/');
  });

  test('does not launch when Starter Work retry state is unavailable', async () => {
    window.history.pushState(
      {},
      '',
      '/projects/project-alpha?starter=start-task',
    );
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    render(<ProjectTasksSection slug="project-alpha" />);

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    expect(
      await screen.findByText(
        /Nothing was started\. This device can’t reach its saved record of your first-task setup/,
      ),
    ).toBeTruthy();
    expect(launchStarterTask).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/');
  });

  test('keeps retry-state clear failure visible after real navigation, even when correlation and dispatch both fail', async () => {
    window.history.pushState(
      {},
      '',
      '/projects/project-alpha?starter=start-task',
    );
    launchStarterTask.mockResolvedValue({
      state: 'started',
      task: { id: 'task-2', projectId: 'project-alpha' },
      correlation: {
        state: 'unbound',
        reason: 'correlation unavailable',
      },
      dispatch: {
        state: 'indeterminate',
        reason: 'response lost',
        retrySafe: false,
      },
      evidence: { state: 'NOT_VERIFIED', reason: 'unknown' },
    });
    const remove = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });
    function RoutedTasks() {
      const [pathname, setPathname] = useState('/projects/project-alpha');
      navigationEffect = setPathname;
      return pathname.startsWith('/tasks/') ? (
        <p>Task route</p>
      ) : (
        <ProjectTasksSection slug="project-alpha" />
      );
    }
    render(<RoutedTasks />);

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Starter task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByText('Task route')).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(
      'The Task was created, but this device could not clear its retry state. Reopening Starter Work may return to the same Task.',
      undefined,
      12_000,
    );
    expect(navigate).toHaveBeenCalledWith('/tasks/task-2', {
      starter: 'start-task',
      starterLink: 'not-verified',
    });
    remove.mockRestore();
    window.history.pushState({}, '', '/');
  });

  test('creates a bound task, opens it, and preserves dispatch behavior', async () => {
    createTask.mockImplementation(async () => {
      const task = {
        ...tasks[0],
        id: 'task-2',
        title: 'New task',
      };
      tasks = [task, ...tasks];
      return task;
    });
    dispatchTask.mockResolvedValue({
      task: {
        ...tasks[0],
        status: 'ready',
        sessionId: 'task-task-1-1',
      },
    });

    render(
      <ProjectTasksSection
        slug="project-alpha"
        projectWorkingDirectory="/tmp/project-alpha"
        gitStatus={{
          isRepo: true,
          branch: 'feature/task-workspace',
          changes: [],
          staged: 0,
          unstaged: 0,
          untracked: 0,
          lastCommit: null,
          ahead: 0,
          behind: 0,
          repoRoot: '/tmp/project-alpha-worktree',
        }}
        agents={['agent-one']}
      />,
    );

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'New task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        projectId: 'project-alpha',
        title: 'New task',
        agentId: 'agent-one',
        createdBy: 'user',
        workspaceBinding: {
          workingDirectory: '/tmp/project-alpha',
          repoRoot: '/tmp/project-alpha-worktree',
          worktreePath: '/tmp/project-alpha-worktree',
          branch: 'feature/task-workspace',
          sourceSurface: 'ui',
        },
      }),
    );

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/tasks/task-2'));

    navigate.mockReset();
    fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
    expect(navigate).toHaveBeenCalledWith('/tasks/task-2');

    await screen.findByRole('button', { name: 'Dispatch' });
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch' }));

    await waitFor(() =>
      expect(dispatchTask).toHaveBeenCalledWith({
        taskId: 'task-2',
        dispatch: {
          agentId: 'agent-one',
          skillName: undefined,
          runtimeConfig: { cwd: '/tmp/project-alpha' },
          sourceSurface: 'project-page',
        },
      }),
    );
    expect(screen.getByText(/spawned session/)).toBeTruthy();
  });

  test('keeps non-repository values unavailable while retaining the exact working directory', async () => {
    createTask.mockResolvedValue(tasks[0]);

    render(
      <ProjectTasksSection
        slug="project-alpha"
        projectWorkingDirectory="/tmp/project-alpha"
        gitStatus={{ isRepo: false }}
      />,
    );

    expect(screen.getByText('Git top-level')).toBeTruthy();
    expect(screen.getAllByText('Unavailable')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'No repo task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith({
        projectId: 'project-alpha',
        title: 'No repo task',
        agentId: undefined,
        createdBy: 'user',
        workspaceBinding: {
          workingDirectory: '/tmp/project-alpha',
          repoRoot: undefined,
          worktreePath: undefined,
          branch: undefined,
          sourceSurface: 'ui',
        },
      }),
    );
  });
  test('shows a compact workflow line, tagged "matched by title", on a title-heuristic match', async () => {
    workflowTasks = [
      {
        taskSlug: 'existing-task',
        status: 'blocked',
        phase: 'verification',
        updatedAt: '2026-05-03T00:00:00.000Z',
        nextAction: { status: 'blocked', summary: 'Waiting on review' },
        hasHandoff: false,
        path: '.kontourai/flow-agents/existing-task',
      },
    ];

    render(<ProjectTasksSection slug="project-alpha" />);

    const workflowLine = await screen.findByTestId('workflow-status-line');
    expect(workflowLine.textContent).toContain('blocked');
    expect(workflowLine.textContent).toContain('verification');
    expect(
      screen.getByTestId('workflow-status-line-hint').textContent,
    ).toContain('matched by title');
  });

  test('prefers a durable workItemRef match and does NOT tag it as heuristic', async () => {
    tasks[0] = { ...tasks[0], workItemRef: 'existing-task' };
    workflowTasks = [
      {
        taskSlug: 'existing-task',
        status: 'in_progress',
        phase: 'execution',
        updatedAt: '2026-05-03T00:00:00.000Z',
        nextAction: { status: 'continue', summary: 'Working' },
        hasHandoff: false,
        path: '.kontourai/flow-agents/existing-task',
        flowRun: {
          current_step: 'execute',
          open_gate_ids: ['execute-gate'],
        },
      },
    ];

    render(<ProjectTasksSection slug="project-alpha" />);

    const workflowLine = await screen.findByTestId('workflow-status-line');
    expect(workflowLine.textContent).toContain('in_progress');
    expect(workflowLine.textContent).toContain('step: execute');
    expect(workflowLine.textContent).toContain('gate: execute-gate');
    expect(screen.queryByTestId('workflow-status-line-hint')).toBeNull();
  });

  test('renders no workflow line when there is no exact task_slug match', () => {
    workflowTasks = [
      {
        taskSlug: 'unrelated-task',
        status: 'new',
        phase: 'pickup',
        updatedAt: '2026-05-03T00:00:00.000Z',
        nextAction: { status: 'continue', summary: 'Picked up' },
        hasHandoff: false,
        path: '.kontourai/flow-agents/unrelated-task',
      },
    ];

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(screen.queryByTestId('workflow-status-line')).toBeNull();
  });

  test('suppresses the join when two project tasks normalize to the same slug (collision)', () => {
    tasks = [
      {
        ...tasks[0],
        id: 'task-1',
        title: 'Existing Task!!',
      },
      {
        ...tasks[0],
        id: 'task-2',
        title: 'existing_task', // normalizes to the same slug as task-1
      },
    ];
    workflowTasks = [
      {
        taskSlug: 'existing-task',
        status: 'blocked',
        phase: 'verification',
        updatedAt: '2026-05-03T00:00:00.000Z',
        nextAction: { status: 'blocked', summary: 'Waiting on review' },
        hasHandoff: false,
        path: '.kontourai/flow-agents/existing-task',
      },
    ];

    render(<ProjectTasksSection slug="project-alpha" />);

    // task-1 is selected by default — no workflow line renders because the
    // slug is ambiguous across the project's tasks.
    expect(screen.queryByTestId('workflow-status-line')).toBeNull();

    // Selecting the other colliding task also renders nothing.
    fireEvent.click(screen.getByText('existing_task'));
    expect(screen.queryByTestId('workflow-status-line')).toBeNull();
  });

  test('renders provider-backed work items alongside local tasks, tagged with a source chip', async () => {
    workItemsData = {
      providers: [
        {
          identity: { kind: 'local', id: 'local', label: 'Station' },
          capabilities: {
            readOnly: false,
            supportsDispatch: true,
            supportsStatusWrite: false,
          },
          available: true,
          items: [],
        },
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github:kontourai/station',
            label: 'GitHub (kontourai/station)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: true,
          items: [
            {
              id: 'github:kontourai/station#583',
              title: 'Linked work item for the Tasks board',
              status: 'ready',
              provider: {
                kind: 'flow-agents-github',
                id: 'flow-agents-github:kontourai/station',
                label: 'GitHub (kontourai/station)',
              },
              workItemRef: 'github:kontourai/station#583',
              url: 'https://github.com/kontourai/station/issues/583',
            },
          ],
        },
      ],
    };

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(
      await screen.findByText('Linked work item for the Tasks board'),
    ).toBeTruthy();
    expect(screen.getByTestId('provider-chip').textContent).toBe(
      'GitHub (kontourai/station)',
    );

    fireEvent.click(screen.getByText('Linked work item for the Tasks board'));

    expect(screen.getByTestId('source-chip-detail').textContent).toBe(
      'GitHub (kontourai/station)',
    );
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
    expect(
      screen.getByText(
        'Linked work item — dispatch is not available for this item yet.',
      ),
    ).toBeTruthy();
  });

  test('omits a provider item once a local task has already joined the same workItemRef', () => {
    tasks[0] = { ...tasks[0], workItemRef: 'github:kontourai/station#583' };
    workItemsData = {
      providers: [
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github:kontourai/station',
            label: 'GitHub (kontourai/station)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: true,
          items: [
            {
              id: 'github:kontourai/station#583',
              title: 'Linked work item for the Tasks board',
              status: 'ready',
              provider: {
                kind: 'flow-agents-github',
                id: 'flow-agents-github:kontourai/station',
                label: 'GitHub (kontourai/station)',
              },
              workItemRef: 'github:kontourai/station#583',
            },
          ],
        },
      ],
    };

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(screen.queryByTestId('provider-chip')).toBeNull();
    expect(
      screen.queryByText('Linked work item for the Tasks board'),
    ).toBeNull();
  });

  test('renders local-only behavior with zero errors when no provider backend is available', () => {
    workItemsData = {
      providers: [
        {
          identity: { kind: 'local', id: 'local', label: 'Station' },
          capabilities: {
            readOnly: false,
            supportsDispatch: true,
            supportsStatusWrite: false,
          },
          available: true,
          items: [],
        },
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github',
            label: 'Flow Agents (GitHub)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: false,
          items: [],
          reason: 'no backlog provider settings configured',
        },
      ],
    };

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(screen.getAllByText('Existing task').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('provider-chip')).toBeNull();
  });

  test('does not hide a provider item behind an unnamespaced (opaque) local workItemRef', () => {
    // An unnamespaced ref ('583', not 'github:owner/repo#583') must never be
    // treated as a safe cross-provider join key — see the archive#583
    // finding on false-hiding via bare-string collisions.
    tasks[0] = { ...tasks[0], workItemRef: '583' };
    workItemsData = {
      providers: [
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github:kontourai/station',
            label: 'GitHub (kontourai/station)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: true,
          items: [
            {
              id: '583',
              title: 'Unrelated item with a colliding bare id',
              status: 'ready',
              provider: {
                kind: 'flow-agents-github',
                id: 'flow-agents-github:kontourai/station',
                label: 'GitHub (kontourai/station)',
              },
              workItemRef: '583',
            },
          ],
        },
      ],
    };

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(
      screen.getByText('Unrelated item with a colliding bare id'),
    ).toBeTruthy();
  });

  test('reconciles a stranded selection when the selected provider item vanishes on refresh', async () => {
    const providerItem = {
      id: 'github:kontourai/station#583',
      title: 'Linked work item for the Tasks board',
      status: 'ready',
      provider: {
        kind: 'flow-agents-github',
        id: 'flow-agents-github:kontourai/station',
        label: 'GitHub (kontourai/station)',
      },
      workItemRef: 'github:kontourai/station#583',
    };
    workItemsData = {
      providers: [
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github:kontourai/station',
            label: 'GitHub (kontourai/station)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: true,
          items: [providerItem],
        },
      ],
    };

    const { rerender } = render(<ProjectTasksSection slug="project-alpha" />);

    fireEvent.click(
      await screen.findByText('Linked work item for the Tasks board'),
    );
    expect(screen.getByTestId('source-chip-detail')).toBeTruthy();

    // Simulate the 30s refetch dropping the selected item (dedupe, board
    // movement, or the provider going unavailable).
    workItemsData = {
      providers: [
        {
          identity: {
            kind: 'flow-agents-github',
            id: 'flow-agents-github:kontourai/station',
            label: 'GitHub (kontourai/station)',
          },
          capabilities: {
            readOnly: true,
            supportsDispatch: false,
            supportsStatusWrite: false,
          },
          available: true,
          items: [],
        },
      ],
    };
    rerender(<ProjectTasksSection slug="project-alpha" />);

    // The stale selection is reconciled: the provider-item detail pane is
    // gone, and selection falls back to the local task instead of leaving
    // the pane stuck rendering nothing for the vanished item forever.
    expect(screen.queryByTestId('source-chip-detail')).toBeNull();
    await waitFor(() =>
      expect(screen.getByText('No session yet')).toBeTruthy(),
    );
  });

  // Roadmap archive#584, part of epic archive#580, S4: dispatch-as-claim UI.
  describe('AssignmentProvider claim state', () => {
    test('a claimed-by-other task guards the Dispatch button with the actor surfaced', () => {
      tasks[0] = { ...tasks[0], workItemRef: 'github:kontourai/station#584' };
      taskClaim = {
        state: 'claimed-by-other',
        actor: {
          runtime: 'flow-agents-cli',
          sessionId: 'cli-session-9',
          host: 'other-host',
          human: null,
        },
      };

      render(<ProjectTasksSection slug="project-alpha" />);

      expect(screen.getByTestId('task-claim-badge').textContent).toContain(
        'flow-agents-cli:cli-session-9',
      );
      const dispatchButton = screen.getByRole('button', {
        name: 'Claimed by another actor',
      }) as HTMLButtonElement;
      expect(dispatchButton.disabled).toBe(true);
      fireEvent.click(dispatchButton);
      expect(dispatchTask).not.toHaveBeenCalled();
    });

    test('a claimed-by-me task shows a badge and leaves Dispatch enabled', () => {
      tasks[0] = { ...tasks[0], workItemRef: 'github:kontourai/station#584' };
      taskClaim = { state: 'claimed-by-me' };

      render(<ProjectTasksSection slug="project-alpha" />);

      expect(screen.getByTestId('task-claim-badge').textContent).toBe(
        'Claimed by you',
      );
      expect(
        (screen.getByRole('button', { name: 'Dispatch' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    test('a free provider-backed task shows no claim badge and dispatch is unguarded', () => {
      tasks[0] = { ...tasks[0], workItemRef: 'github:kontourai/station#584' };
      taskClaim = {
        state: 'free',
        subjectId: 'github:kontourai/station#584',
      } as any;

      render(<ProjectTasksSection slug="project-alpha" />);

      expect(screen.queryByTestId('task-claim-badge')).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Dispatch' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    test('a claimed provider item detail pane shows a read-only claim badge', async () => {
      workItemsData = {
        providers: [
          {
            identity: {
              kind: 'flow-agents-github',
              id: 'flow-agents-github:kontourai/station',
              label: 'GitHub (kontourai/station)',
            },
            capabilities: {
              readOnly: true,
              supportsDispatch: false,
              supportsStatusWrite: false,
            },
            available: true,
            items: [
              {
                id: 'github:kontourai/station#583',
                title: 'Linked work item for the Tasks board',
                status: 'ready',
                provider: {
                  kind: 'flow-agents-github',
                  id: 'flow-agents-github:kontourai/station',
                  label: 'GitHub (kontourai/station)',
                },
                workItemRef: 'github:kontourai/station#583',
              },
            ],
          },
        ],
      };
      providerItemClaim = {
        state: 'claimed',
        actor: {
          runtime: 'station',
          sessionId: 'task-other-1',
          host: 'other-station-host',
          human: null,
        },
      };

      render(<ProjectTasksSection slug="project-alpha" />);

      fireEvent.click(
        await screen.findByText('Linked work item for the Tasks board'),
      );

      expect(screen.getByTestId('provider-claim-badge').textContent).toContain(
        'station:task-other-1',
      );
    });
  });
});

/**
 * `data: tasks = []` alone makes a failed `useTasksQuery` read
 * indistinguishable from a project with no tasks — the task list claimed
 * "No tasks yet." over a read that never answered.
 */
describe('ProjectTasksSection error state (Review H1)', () => {
  beforeEach(() => {
    invalidateQueries.mockReset();
    createTask.mockReset();
    dispatchTask.mockReset();
    navigate.mockReset();
    refetchTasks.mockReset();
    useTasksQuery.mockReset();
    useWorkflowTasksQuery.mockReset();
    useWorkflowTasksQuery.mockImplementation(() => ({ data: [] }));
    useWorkItemsQuery.mockReset();
    useWorkItemsQuery.mockImplementation(() => ({ data: { providers: [] } }));
    taskClaim = { state: 'none' };
    providerItemClaim = { state: 'free' };
  });

  test('an errored read renders the error state, not "No tasks yet."', () => {
    useTasksQuery.mockImplementation(() => ({
      data: [],
      error: new Error('tasks read failed'),
      refetch: refetchTasks,
    }));

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load tasks')).toBeTruthy();
    expect(screen.getByText('tasks read failed')).toBeTruthy();
    expect(screen.queryByText('No tasks yet.')).toBeNull();
  });

  test('a settled-empty read still renders "No tasks yet.", with no error state', () => {
    useTasksQuery.mockImplementation(() => ({
      data: [],
      error: undefined,
      refetch: refetchTasks,
    }));

    render(<ProjectTasksSection slug="project-alpha" />);

    expect(screen.getByText('No tasks yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('clicking Retry calls the tasks query refetch', () => {
    useTasksQuery.mockImplementation(() => ({
      data: [],
      error: new Error('tasks read failed'),
      refetch: refetchTasks,
    }));

    render(<ProjectTasksSection slug="project-alpha" />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchTasks).toHaveBeenCalledTimes(1);
  });
});
