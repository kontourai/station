/** @vitest-environment jsdom */
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  status: vi.fn(),
  get: vi.fn(),
  answers: [] as unknown[],
  outputs: [] as unknown[],
  brief:
    '# Goal\nShip a calm chat room.\n\n## Done when\n- [x] Chat comes first\n- [ ] Answers return here',
}));
vi.mock('@kontourai/station-sdk', () => ({
  getJson: mocks.get,
  mutateJson: mocks.rename,
  useTaskTurnReferencesQuery: () => ({ data: mocks.answers }),
  useUpdateTaskStatusMutation: () => ({
    mutateAsync: mocks.status,
    isPending: false,
  }),
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  useProjectTaskRoomDocumentQuery: () => ({
    data: {
      kind: 'snapshot',
      text: mocks.brief,
      revision: 'r1',
    },
  }),
}));
vi.mock('@kontourai/station-sdk/task-outputs', () => ({
  useTaskOutputsQuery: () => ({ data: mocks.outputs }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station',
    authorityKey: 'owner',
    isCurrent: () => true,
  }),
}));
vi.mock('../workspace-panes/ProjectTaskRoomPresence', () => ({
  ProjectTaskRoomPresence: ({ compact }: { compact?: boolean }) => (
    <span>{compact ? 'Present avatars' : 'Here now'}</span>
  ),
}));
vi.mock('../views/project-page/ProjectTaskSharingControl', () => ({
  ProjectTaskSharingControl: () => <button type="button">Share Task</button>,
}));
vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../views/task-workspace/TaskOutputsSection', () => ({
  TaskOutputRow: ({ output }: { output: { title: string } }) => (
    <li>{output.title}</li>
  ),
}));

import {
  TaskRoomHeader,
  TaskRoomRail,
  TaskRoomResults,
} from '../views/task-workspace/TaskRoomPage';

const task: TaskRecord = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Make the Task the room',
  description: '',
  priority: 'normal',
  status: 'in_progress',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  createdBy: 'alice',
  workspaceBinding: { availability: 'available', branch: 'feat/room' },
};
function mount(children: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.brief =
    '# Goal\nShip a calm chat room.\n\n## Done when\n- [x] Chat comes first\n- [ ] Answers return here';
  mocks.answers = [];
  mocks.outputs = [];
  mocks.rename
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: task })),
    );
  mocks.status.mockReset().mockResolvedValue(task);
  mocks.get
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] })),
    );
});
test('header edits the title and offers only permitted status transitions, sharing and details', async () => {
  const details = vi.fn();
  mount(
    <TaskRoomHeader
      task={task}
      projectId="project-1"
      projectSlug="project"
      onDetails={details}
    />,
  );
  const select = screen.getByRole('combobox', { name: 'Task status' });
  expect(
    Array.from((select as HTMLSelectElement).options).map(
      (option) => option.value,
    ),
  ).toEqual([
    'in_progress',
    'blocked',
    'review',
    'verification',
    'done',
    'canceled',
  ]);
  fireEvent.change(select, { target: { value: 'done' } });
  await waitFor(() =>
    expect(mocks.status).toHaveBeenCalledWith({
      taskId: task.id,
      status: 'done',
      apiBase: 'http://station',
    }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Edit title: Make the Task the room' }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), {
    target: { value: 'A calmer room' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
  await waitFor(() =>
    expect(mocks.rename).toHaveBeenCalledWith(
      'http://station/api/tasks/task-1/title',
      'PATCH',
      expect.anything(),
      { title: 'A calmer room', expectedCreatedAt: task.createdAt },
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Task details' }));
  expect(details).toHaveBeenCalledOnce();
});
test('rail derives the goal and completion checklist from the saved shared document', () => {
  const brief = vi.fn();
  mount(
    <TaskRoomRail
      task={task}
      projectSlug="project"
      onBrief={brief}
      onResults={vi.fn()}
    />,
  );
  expect(screen.getByText('Ship a calm chat room.')).toBeTruthy();
  expect(screen.getByText('Chat comes first')).toBeTruthy();
  expect(screen.getByLabelText('Checked')).toBeTruthy();
  expect(screen.getByText('Answers return here')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit brief' }));
  expect(brief).toHaveBeenCalledOnce();
});
test('results presents kept answers, file outputs and pull requests in a single list', async () => {
  mocks.answers = [
    {
      id: 'answer',
      state: 'available',
      sessionId: 'session',
      turnId: 'turn',
      answer: { content: 'Kept investigation' },
    },
  ];
  mocks.outputs = [{ id: 'output', title: 'Design.md' }];
  mocks.get.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: [
          {
            provider: 'github',
            host: 'github.com',
            nativeId: '41',
            repository: { owner: 'team', name: 'app' },
            ref: '41',
            provenance: { sessionId: 'session' },
          },
        ],
      }),
    ),
  );
  mount(<TaskRoomResults task={task} />);
  const list = screen.getByRole('list', { name: 'Kept results' });
  await waitFor(() =>
    expect(within(list).getAllByRole('listitem')).toHaveLength(3),
  );
  expect(within(list).getByText('Kept investigation')).toBeTruthy();
  expect(within(list).getByText('Design.md')).toBeTruthy();
  expect(within(list).getByText('team/app #41')).toBeTruthy();
});

test('rail uses the named sections and falls back to description or a readable excerpt', () => {
  mocks.brief =
    '## Notes\n- [ ] Not a completion item\n\n## Done when\n- [x] The accepted goal is met';
  const view = mount(
    <TaskRoomRail
      task={{ ...task, description: 'Description goal' }}
      projectSlug="project"
      onBrief={vi.fn()}
      onResults={vi.fn()}
    />,
  );
  expect(screen.getByText('Description goal')).toBeTruthy();
  expect(screen.queryByText('Not a completion item')).toBeNull();
  expect(screen.getByText('The accepted goal is met')).toBeTruthy();
  view.unmount();
  mocks.brief = 'An unstructured plan still has useful context.';
  mount(
    <TaskRoomRail
      task={task}
      projectSlug="project"
      onBrief={vi.fn()}
      onResults={vi.fn()}
    />,
  );
  expect(screen.getAllByText(mocks.brief).length).toBeGreaterThan(0);
});
