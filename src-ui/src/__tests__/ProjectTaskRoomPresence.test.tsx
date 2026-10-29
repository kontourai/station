/** @vitest-environment jsdom */

import type {
  ProjectTaskRoomBrowserLiveSnapshot,
  ProjectTaskRoomLiveCommand,
  ProjectTaskRoomLiveResult,
} from '@kontourai/station-sdk/project-task-rooms';
import { render, screen, waitFor } from '@testing-library/react';
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

  test('shows only published participants by their display names without join or leave controls', () => {
    render(<ProjectTaskRoomPresence taskId="task-1" />);
    expect(screen.getByText('Participant peer')).toBeTruthy();
    expect(screen.queryByText('Participant self')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Join|Leave|Announce/ }),
    ).toBeNull();
  });
});
