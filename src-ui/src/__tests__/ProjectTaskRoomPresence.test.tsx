/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
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
    },
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
    snapshot: mocks.room.live,
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
