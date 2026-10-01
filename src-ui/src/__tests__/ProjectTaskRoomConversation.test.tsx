/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: {
    data: { kind: 'unavailable' } as Record<string, unknown>,
    isLoading: false,
  },
  stream: 'live' as 'live' | 'terminal',
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
    data: { pages: [] },
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

  test('retains readable history while disabling messages after revocation', () => {
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
