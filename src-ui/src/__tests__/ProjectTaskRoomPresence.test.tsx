/** @vitest-environment jsdom */

import type { ProjectTaskRoomBrowserLiveMutationResult } from '@kontourai/station-contracts/project-task-room-browser';
import type {
  ProjectTaskRoomBrowserLiveSnapshot,
  ProjectTaskRoomLiveCommand,
  ProjectTaskRoomLiveResult,
} from '@kontourai/station-sdk/project-task-rooms';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  command:
    vi.fn<
      (
        command: ProjectTaskRoomLiveCommand,
      ) => Promise<ProjectTaskRoomLiveResult>
    >(),
  room: {
    discovery: {
      data: { kind: 'existing', capabilities: { live: true } },
    },
    stream: 'live' as const,
    commandPending: false,
    ownActorId: 'actor-self',
    live: {
      generation: 'generation-1',
      viewerActorId: 'actor-self',
      scope: { projectId: 'project-1', taskId: 'task-1' },
      state: 'active',
      participants: [
        {
          actor: {
            actorId: 'actor-self',
            kind: 'human',
            label: 'Participant self',
          },
          work: {
            sessionId: 'generation-1',
            workName: 'Project task work',
            workState: 'working',
            startedAt: 1,
          },
          publication: 'private',
        },
        {
          actor: {
            actorId: 'actor-peer',
            kind: 'human',
            label: 'Participant peer',
          },
          work: {
            sessionId: 'generation-1',
            workName: 'Project task work',
            workState: 'working',
            startedAt: 1,
          },
          publication: 'published',
        },
      ],
      panes: [],
      cursors: [],
    } satisfies ProjectTaskRoomBrowserLiveSnapshot,
  },
}));
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    ...mocks.room,
    command: mocks.command,
  }),
}));

import { subscribeInteractiveWorkspacePerformanceMarks } from '../performance/interactive-workspace-performance-hooks';
import { ProjectTaskRoomPresence } from '../workspace-panes/ProjectTaskRoomPresence';

beforeEach(() => {
  mocks.command.mockReset();
  mocks.command.mockResolvedValue({
    kind: 'available',
    generation: 'generation-1',
    snapshot: { ...mocks.room.live, result: { outcome: 'joined' } },
  });
});

describe('ProjectTaskRoomPresence', () => {
  test('marks the actual published participant layout with server actor identities', async () => {
    const marks: unknown[] = [];
    const unsubscribe = subscribeInteractiveWorkspacePerformanceMarks((event) =>
      marks.push(event),
    );
    render(<ProjectTaskRoomPresence taskId="task-1" />);
    await waitFor(() =>
      expect(marks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'room-presence-commit',
            mark: expect.objectContaining({
              taskId: 'task-1',
              viewerActorId: 'actor-self',
              participantActorIds: ['actor-peer'],
            }),
          }),
        ]),
      ),
    );
    unsubscribe();
  });

  test('uses the shared live authority for join, announce, watch, and follow', async () => {
    render(<ProjectTaskRoomPresence taskId="task-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Announce work' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Watch Participant peer' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Follow Participant peer' }),
    );
    await vi.waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(4));
    expect(mocks.command.mock.calls.map(([command]) => command)).toEqual([
      { command: 'join' },
      { command: 'announce' },
      {
        command: 'watch',
        paneId: 'task-room-editor:task-1',
        targetActorId: 'actor-peer',
      },
      {
        command: 'follow',
        paneId: 'task-room-editor:task-1',
        targetActorId: 'actor-peer',
      },
    ]);
  });

  test('keeps self controls after a hard-reload projection where self is already published', () => {
    const self = mocks.room.live.participants[0]!;
    const priorParticipants = mocks.room.live.participants;
    mocks.room.live.participants = [{ ...self, publication: 'published' }];
    try {
      render(<ProjectTaskRoomPresence taskId="task-1" />);
      expect(
        screen
          .getByRole('button', { name: 'Announce work' })
          .matches(':disabled'),
      ).toBe(false);
      expect(
        screen.getByRole('button', { name: 'Leave room' }).matches(':disabled'),
      ).toBe(false);
      expect(
        screen.queryByRole('button', { name: 'Watch Participant self' }),
      ).toBeNull();
    } finally {
      mocks.room.live.participants = priorParticipants;
    }
  });
});

test.each([
  ['invalid', 'This live collaboration action could not be accepted.'],
  [
    'forbidden',
    'Your access to this live room changed. Refresh before trying again.',
  ],
  [
    'identity_changed',
    'Your access to this live room changed. Refresh before trying again.',
  ],
  ['capacity_exceeded', 'The live room has reached its capacity.'],
  ['rate_limited', 'Live collaboration is busy. Wait before trying again.'],
  ['unavailable', 'Live collaboration is unavailable.'],
  ['degraded', 'Station could not confirm this live collaboration action.'],
] as const)(
  'reports %s without retrying or inventing membership, then clears after accepted Join',
  async (outcome, copy) => {
    const priorParticipants = mocks.room.live.participants;
    mocks.room.live.participants = [];
    mocks.command.mockResolvedValueOnce({
      kind: 'available',
      generation: 'generation-1',
      snapshot: {
        ...mocks.room.live,
        result: (outcome === 'degraded'
          ? { outcome, state: 'indeterminate', intentId: 'intent-fixture' }
          : { outcome }) satisfies ProjectTaskRoomBrowserLiveMutationResult,
      },
    });
    try {
      render(<ProjectTaskRoomPresence taskId="task-1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
      expect((await screen.findByRole('alert')).textContent).toBe(copy);
      expect(mocks.command).toHaveBeenCalledTimes(1);
      expect(
        screen
          .getByRole('button', { name: 'Announce work' })
          .matches(':disabled'),
      ).toBe(true);
      expect(
        screen.getByRole('button', { name: 'Leave room' }).matches(':disabled'),
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(
        screen
          .getByRole('button', { name: 'Announce work' })
          .matches(':disabled'),
      ).toBe(true);
    } finally {
      mocks.room.live.participants = priorParticipants;
    }
  },
);

test('reports a refused material action without treating it as an uncertain success', async () => {
  mocks.command.mockResolvedValueOnce({
    kind: 'available',
    generation: 'generation-1',
    snapshot: {
      ...mocks.room.live,
      result: {
        outcome: 'degraded',
        state: 'refused',
        intentId: 'fixture-intent',
      } satisfies ProjectTaskRoomBrowserLiveMutationResult,
    },
  });
  render(<ProjectTaskRoomPresence taskId="task-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Announce work' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This live collaboration action was not accepted.',
  );
  expect(mocks.command).toHaveBeenCalledTimes(1);
});
