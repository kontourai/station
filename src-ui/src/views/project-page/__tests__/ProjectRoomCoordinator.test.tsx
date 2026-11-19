/** @vitest-environment jsdom */
import type {
  ProjectRoomCoordinatorTask,
  ProjectRoomCoordinatorView,
} from '@kontourai/station-contracts/project-room-coordinator';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  RoomCoordinatorBar,
  RoomCoordinatorCard,
  type RoomCoordinatorPorts,
  useRoomCoordinatorEnabled,
} from '../ProjectRoomCoordinator';

const state = vi.hoisted(() => ({
  preview: true,
  capability: true as boolean | null,
  capabilityEnabled: [] as boolean[],
  view: undefined as ProjectRoomCoordinatorView | undefined,
  queryError: false,
  refetch: vi.fn(),
  start: vi.fn(),
  sweep: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(state.preview ? ['project-room-coordinator'] : []),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock('@kontourai/station-sdk/project-room-coordinator', () => ({
  useProjectRoomCoordinatorCapability: (enabled: boolean) => {
    state.capabilityEnabled.push(enabled);
    return { data: enabled ? state.capability : undefined };
  },
  useProjectRoomCoordinator: () => ({
    data: state.queryError ? undefined : state.view,
    isError: state.queryError,
    refetch: state.refetch,
  }),
  useStartProjectRoomCoordinatorTasks: () => ({
    isPending: false,
    error: null,
    mutate: state.start,
    reset: vi.fn(),
  }),
  useProjectRoomStatusSweep: () => ({
    isPending: false,
    error: null,
    mutate: state.sweep,
  }),
}));

const task = (
  rowId: string,
  title: string,
  extra: Partial<ProjectRoomCoordinatorTask> = {},
): ProjectRoomCoordinatorTask => ({
  rowId,
  title,
  prompt: `${title}.`,
  agentId: 'builder',
  agentLabel: 'Builder',
  placement: 'worktree',
  mayOpenPullRequest: false,
  pullRequestRefusals: 0,
  state: 'proposed',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...extra,
});

const ports: RoomCoordinatorPorts = {
  requestScope: { apiBase: '', authorityKey: 'local' },
  slug: 'alpha',
  guards: {
    expectedRoomId: 'room',
    expectedProjectId: 'project',
    expectedActorId: 'ada',
  },
  canStart: true,
};

beforeEach(() => {
  state.preview = true;
  state.capability = true;
  state.capabilityEnabled = [];
  state.queryError = false;
  state.view = {
    projectSlug: 'alpha',
    settings: {
      startWithoutAsking: false,
      maxConcurrentTasks: 2,
      pullRequests: 'when-asked',
    },
    working: 2,
    waiting: 1,
    proposals: [
      {
        proposalId: 'card-1',
        messageId: 'message-1',
        createdAt: '2026-11-17T00:00:00.000Z',
        tasks: [
          task('row-1', 'Fix login'),
          task('row-2', 'Update docs'),
          task('row-3', 'Bump deps', {
            state: 'working',
            taskId: 'task-3',
            pullRequestRefusals: 1,
          }),
        ],
      },
    ],
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('a card lists each suggested Task with Start per row and Start all', () => {
  render(<RoomCoordinatorCard messageId="message-1" ports={ports} />);
  expect(screen.getByText('Fix login')).toBeTruthy();
  expect(screen.getAllByText('Builder · Own worktree')).toHaveLength(3);
  expect(screen.getByText('Working')).toBeTruthy();
  expect(
    screen.getByText('Station refused a pull request you did not ask for.'),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Start Fix login' }));
  expect(state.start).toHaveBeenLastCalledWith({
    proposalId: 'card-1',
    rowIds: ['row-1'],
  });
  // Start all names no rows: the server starts every proposed one.
  fireEvent.click(screen.getByRole('button', { name: 'Start all 2' }));
  expect(state.start).toHaveBeenLastCalledWith({ proposalId: 'card-1' });

  fireEvent.click(screen.getByRole('button', { name: 'Open Task Bump deps' }));
  expect(state.navigate).toHaveBeenCalledWith('/tasks/task-3');
});

test('a card belongs to its own message only', () => {
  const { container } = render(
    <RoomCoordinatorCard messageId="message-2" ports={ports} />,
  );
  expect(container.innerHTML).toBe('');
});

test('a person who may not start work sees the card without Start', () => {
  render(
    <RoomCoordinatorCard
      messageId="message-1"
      ports={{ ...ports, canStart: false }}
    />,
  );
  expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
});

test('the bar shows the limit at work and runs the status sweep', () => {
  render(<RoomCoordinatorBar ports={ports} />);
  expect(screen.getByRole('status').textContent).toBe(
    '2 working · 1 waiting · up to 2 at once',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Status sweep' }));
  expect(state.sweep).toHaveBeenCalledTimes(1);
});

test('the bar offers Retry when the coordinator cannot be read', () => {
  state.queryError = true;
  render(<RoomCoordinatorBar ports={ports} />);
  expect(screen.getByRole('status').textContent).toBe(
    'Coordinator unavailable',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

function Probe({ general }: { general: boolean }) {
  return <span>{String(useRoomCoordinatorEnabled(general))}</span>;
}

test('only #general with the preview on and a capable host has a coordinator', () => {
  const { rerender } = render(<Probe general />);
  expect(screen.getByText('true')).toBeTruthy();
  rerender(<Probe general={false} />);
  expect(screen.getByText('false')).toBeTruthy();
  state.preview = false;
  rerender(<Probe general />);
  expect(screen.getByText('false')).toBeTruthy();
  // With the preview off the host is not even asked.
  expect(state.capabilityEnabled.at(-1)).toBe(false);
  state.preview = true;
  state.capability = false;
  rerender(<Probe general />);
  expect(screen.getByText('false')).toBeTruthy();
});
