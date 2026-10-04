/** @vitest-environment jsdom */

import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: {
    data: { kind: 'unavailable' } as Record<string, unknown>,
    isLoading: false,
  },
  stream: 'live' as 'live' | 'terminal',
  records: [] as ProjectTaskRoomBrowserRecord[],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'test',
    isCurrent: () => true,
  }),
}));
vi.mock('../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  TaskRoomWorkNotSentError: class extends Error {},
  useTaskRoomAgentOptionsQuery: () => ({
    data: { targets: [] },
    isLoading: false,
    isError: false,
  }),
  useTaskRoomAgentRequestsQuery: () => ({
    data: { records: [] },
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useSubmitTaskRoomAgentRequestMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useProjectTaskRoomDiscoveryQuery: () => mocks.discovery,
  useProjectTaskRoomHistoryQuery: () => ({
    data: { pages: [{ kind: 'available', records: mocks.records }] },
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useAppendProjectTaskRoomHumanMessageMutation: () => ({
    isPending: false,
    isError: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    discovery: mocks.discovery,
    stream: mocks.stream,
  }),
}));

import { ProjectTaskRoomConversation } from '../workspace-panes/ProjectTaskRoomConversation';

beforeEach(() => {
  mocks.discovery.isLoading = false;
  mocks.discovery.data = { kind: 'unavailable' };
  mocks.stream = 'live';
  mocks.records = [];
});

describe('ProjectTaskRoomConversation capability states', () => {
  test.each([
    [true, true, 'Room history is readable and messages can be sent.', false],
    [true, false, 'Room history is readable and read-only.', true],
    [
      false,
      true,
      'Message sending is available, but room history is not readable.',
      false,
    ],
    [false, false, 'Room history and message writing are unavailable.', true],
  ])(
    'names history=%s write=%s without collapsing capability truth',
    (historyRead, messageWrite, copy, disabled) => {
      mocks.discovery.data = {
        kind: 'existing',
        capabilities: { historyRead, messageWrite, revisionLinks: false },
      };
      render(
        <ProjectTaskRoomConversation
          taskId="task-1"
          projectSlug="demo"
          taskCreatedAt="2026-09-30T12:00:00.000Z"
        />,
      );
      expect(screen.getAllByRole('status')[0].textContent).toBe(copy);
      expect(
        screen.getByRole('textbox', { name: 'Message' }).matches(':disabled'),
      ).toBe(disabled);
    },
  );

  test('presents read-only capabilities and disables messages for a terminal room', () => {
    mocks.discovery.data = {
      kind: 'existing',
      capabilities: {
        historyRead: true,
        messageWrite: true,
        revisionLinks: false,
      },
    };
    mocks.stream = 'terminal';
    render(
      <ProjectTaskRoomConversation
        taskId="task-1"
        projectSlug="demo"
        taskCreatedAt="2026-09-30T12:00:00.000Z"
      />,
    );
    expect(screen.getAllByRole('status')[0].textContent).toBe(
      'Room history is readable and read-only.',
    );
    expect(
      screen.getByRole('textbox', { name: 'Message' }).matches(':disabled'),
    ).toBe(true);
  });
});

test('room review distinguishes a previous Task incarnation while retaining exact output identity', () => {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  mocks.discovery.data = {
    kind: 'existing',
    capabilities: {
      historyRead: true,
      messageWrite: false,
      revisionLinks: false,
    },
  };
  mocks.records = [
    {
      actor: { kind: 'human', label: 'Reviewer' },
      sequence: 1,
      body: {
        kind: 'output-feedback',
        target: {
          outputId: 'previous-output',
          digest,
          taskCreatedAt: '2026-09-30T12:00:00.000Z',
        },
        review: 'accepted',
        text: 'Reviewed earlier bytes',
      },
      digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
      integrity: 'L0',
    },
  ];
  const view = render(
    <ProjectTaskRoomConversation
      taskId="task-1"
      projectSlug="demo"
      taskCreatedAt="2026-10-03T12:00:00.000Z"
    />,
  );
  const history = screen.getByRole('list', { name: 'Task room history' });
  expect(history.textContent).toContain(
    'Earlier Task version. Reviewer accepted this version',
  );
  expect(history.textContent).toContain('previous-output');
  expect(history.textContent).toContain(digest);
  expect(
    screen.getByText(
      'Output reviews are human statements. Task status is unchanged.',
    ),
  ).toBeTruthy();
  view.rerender(
    <ProjectTaskRoomConversation
      taskId="task-1"
      projectSlug="demo"
      taskCreatedAt="2026-09-30T12:00:00.000Z"
    />,
  );
  expect(history.textContent).toContain('Reviewer accepted this version');
  expect(history.textContent).not.toContain('Earlier Task version');
});
