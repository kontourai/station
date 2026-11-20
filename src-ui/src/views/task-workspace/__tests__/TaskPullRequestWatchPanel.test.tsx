/** @vitest-environment jsdom */
import type { TaskPullRequestWatchView } from '@kontourai/station-contracts/pull-request-watch';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TaskPullRequestWatchPanel } from '../TaskPullRequestWatchPanel';

const state = vi.hoisted(() => ({
  preview: true,
  capability: true as boolean | null,
  view: undefined as TaskPullRequestWatchView | undefined,
  queryEnabled: [] as boolean[],
  mutate: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(state.preview ? ['pull-request-agent-feedback'] : []),
}));
vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestFeedbackCapability: () => ({ data: state.capability }),
  useTaskPullRequestWatchQuery: (
    _taskId: string,
    config?: { enabled?: boolean },
  ) => {
    state.queryEnabled.push(config?.enabled ?? true);
    return {
      data: config?.enabled === false ? undefined : state.view,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  useSetTaskPullRequestWatchMutation: () => ({
    isPending: false,
    error: null,
    mutate: state.mutate,
  }),
}));

const task: TaskRecord = {
  id: 'task-1',
  projectId: 'widgets',
  title: 'Fix the login redirect',
  description: '',
  priority: 'normal',
  status: 'in_progress',
  sessionId: 'task-run',
  createdBy: 'user',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
};
const identity = (ref: string) => ({
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'acme', name: 'widgets' },
  ref,
});
const watching: TaskPullRequestWatchView = {
  taskId: 'task-1',
  watching: true,
  source: 'project',
  mode: 'project',
  projectEnabled: true,
  maxFixAttempts: 3,
  available: true,
  pullRequests: [
    {
      identity: identity('42'),
      watch: {
        state: 'ready',
        headSha: 'a1b2c3d4e5f6',
        at: '2026-11-17T01:00:00.000Z',
      },
      fixAttempts: 1,
      maxFixAttempts: 3,
    },
    {
      identity: identity('57'),
      watch: {
        state: 'budget-spent',
        failing: ['ci / unit-tests'],
        headSha: 'b2c3d4e5f6a1',
      },
      fixAttempts: 3,
      maxFixAttempts: 3,
    },
  ],
  refusals: [
    {
      id: 'r1',
      at: '2026-11-17T00:40:00.000Z',
      kind: 'arm-auto-merge',
      outcome: 'refused',
      toolName: 'Bash',
      detail: 'gh pr merge 42 --auto',
    },
  ],
};

beforeEach(() => {
  state.preview = true;
  state.capability = true;
  state.view = watching;
  state.queryEnabled = [];
  state.mutate.mockClear();
});
afterEach(cleanup);

test('shows nothing, and reads nothing, unless the preview is on and the host serves it', () => {
  state.preview = false;
  const { container, rerender } = render(
    <TaskPullRequestWatchPanel task={task} />,
  );
  expect(container.textContent).toBe('');
  state.preview = true;
  state.capability = null;
  rerender(<TaskPullRequestWatchPanel task={task} />);
  expect(container.textContent).toBe('');
  expect(state.queryEnabled.every((enabled) => !enabled)).toBe(true);
});

test('names each watched pull request’s state and the refused actions', () => {
  render(<TaskPullRequestWatchPanel task={task} />);
  expect(
    screen.getByRole('region', { name: 'Pull request watch' }),
  ).toBeTruthy();
  expect(screen.getByText('Ready for you')).toBeTruthy();
  expect(screen.getByText('Fix attempts used')).toBeTruthy();
  expect(screen.getByText('Still failing: ci / unit-tests')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refused actions · 1' }));
  expect(screen.getByText('Arm auto-merge')).toBeTruthy();
  expect(screen.getByText('gh pr merge 42 --auto')).toBeTruthy();
});

test('Stop watching sends off; a Task off by its own choice can follow its Project again', () => {
  const { rerender } = render(<TaskPullRequestWatchPanel task={task} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop watching' }));
  expect(state.mutate).toHaveBeenLastCalledWith('off');
  state.view = { ...watching, watching: false, source: 'task', mode: 'off' };
  rerender(<TaskPullRequestWatchPanel task={task} />);
  fireEvent.click(screen.getByRole('button', { name: 'Watch pull requests' }));
  expect(state.mutate).toHaveBeenLastCalledWith('on');
  fireEvent.click(screen.getByRole('button', { name: 'Use Project setting' }));
  expect(state.mutate).toHaveBeenLastCalledWith('project');
});

test('a head waiting for review or needing recovery never says Ready for you', () => {
  state.view = {
    ...watching,
    pullRequests: [
      {
        ...watching.pullRequests[0]!,
        watch: {
          state: 'reviewing',
          headSha: 'a1b2c3d',
          detail: 'Reviewing this head before reporting it ready.',
        },
      },
    ],
  };
  const { rerender } = render(<TaskPullRequestWatchPanel task={task} />);
  expect(screen.getByText('Review pending')).toBeTruthy();
  expect(screen.queryByText('Ready for you')).toBeNull();
  state.view = {
    ...state.view,
    pullRequests: [
      {
        ...watching.pullRequests[0]!,
        watch: {
          state: 'review-needed',
          headSha: 'a1b2c3d',
          detail:
            'Required findings were dismissed. Open the pull request in its chat and choose Review again.',
        },
      },
    ],
  };
  rerender(<TaskPullRequestWatchPanel task={task} />);
  expect(screen.getByText('Review needs you')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(state.navigate).toHaveBeenCalledWith(
    '/tasks/task-1?taskView=conversation',
  );
  expect(screen.getByText(/Required findings were dismissed/)).toBeTruthy();
  expect(screen.queryByText('Ready for you')).toBeNull();
});

test('a done Task offers no watch controls', () => {
  render(<TaskPullRequestWatchPanel task={{ ...task, status: 'done' }} />);
  expect(screen.queryByRole('button', { name: 'Stop watching' })).toBeNull();
});
