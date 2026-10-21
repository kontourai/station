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
import { PageFrame } from '../components/page-frame';

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
      <PageFrame
        spec={{ title: 'Task', body: 'fill', flush: true }}
        routeIdentity="task:task-1"
      >
        {children}
      </PageFrame>
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
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    task.title,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'In progress · Task status' }),
  );
  expect(
    screen.getAllByRole('menuitemradio').map((item) => item.textContent),
  ).toEqual(['In progress', 'Blocked', 'In review', 'Done', 'Canceled']);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Task details' }));
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

test.each([
  [
    '## Goal\nSeeded goal.\n\n## Done when\n- Plain criterion\n+ Another criterion\n3. Numbered criterion\n\n## Suggested first step\nDo not show this step.',
    'Seeded goal.',
  ],
  [
    'Prose goal.\n\n## Done when\n- Plain criterion\n+ Another criterion\n3. Numbered criterion\n\n## Notes\nDo not show these notes.',
    'Prose goal.',
  ],
])(
  'rail projects only the saved goal and neutral completion bullets (%s)',
  (source, goal) => {
    mocks.brief = source;
    mount(
      <TaskRoomRail
        task={{ ...task, description: 'Stale description' }}
        projectSlug="project"
        onBrief={vi.fn()}
        onResults={vi.fn()}
      />,
    );
    const goalSection = screen
      .getByRole('heading', { name: 'Goal' })
      .closest('section')!;
    expect(within(goalSection).getByText(goal)).toBeTruthy();
    expect(goalSection.textContent).not.toContain('Done when');
    expect(goalSection.textContent).not.toContain('Suggested first step');
    expect(screen.queryByText('Stale description')).toBeNull();
    const completion = screen
      .getByRole('heading', { name: 'Done when' })
      .closest('section')!;
    expect(within(completion).getAllByRole('listitem')).toHaveLength(3);
    expect(within(completion).getByText('Plain criterion')).toBeTruthy();
    expect(within(completion).getByText('Another criterion')).toBeTruthy();
    expect(within(completion).getByText('Numbered criterion')).toBeTruthy();
    expect(within(completion).queryByRole('img')).toBeNull();
  },
);

test('rail parses the description only when the document is empty, with mixed checked and unchecked markers', () => {
  mocks.brief = '';
  mount(
    <TaskRoomRail
      task={{
        ...task,
        description:
          '## Goal\nDescription goal.\n## Done when\n1. [X] Complete\n+ [ ] Pending\n* Neutral\n## Suggested first step\nExcluded step',
      }}
      projectSlug="project"
      onBrief={vi.fn()}
      onResults={vi.fn()}
    />,
  );
  expect(screen.getByText('Description goal.')).toBeTruthy();
  expect(screen.getByLabelText('Checked')).toBeTruthy();
  expect(screen.getByLabelText('Unchecked')).toBeTruthy();
  expect(screen.getByText('Neutral')).toBeTruthy();
  expect(screen.queryByText('Excluded step')).toBeNull();
});

test('a heading-only document does not substitute the description or later sections for a goal', () => {
  mocks.brief = '## Notes\nNot the goal\n## Done when\n- [x] Complete';
  mount(
    <TaskRoomRail
      task={{ ...task, description: 'Stale description' }}
      projectSlug="project"
      onBrief={vi.fn()}
      onResults={vi.fn()}
    />,
  );
  const goal = screen
    .getByRole('heading', { name: 'Goal' })
    .closest('section')!;
  expect(goal.textContent).toContain('Add the goal');
  expect(goal.textContent).not.toContain('Stale description');
  expect(goal.textContent).not.toContain('Not the goal');
});

test('Results retries a failed read in place and preserves the kept content', async () => {
  mocks.get
    .mockReset()
    .mockRejectedValueOnce(new Error('Results offline'))
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] })),
    );
  mocks.answers = [
    {
      id: 'answer',
      state: 'available',
      sessionId: 'session',
      turnId: 'turn',
      answer: { content: 'Kept investigation' },
    },
  ];
  mount(<TaskRoomResults task={task} />);
  await screen.findByText(/Some results could not be loaded/);
  expect(
    screen.getByRole('button', { name: 'Kept investigation' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry results' }));
  await waitFor(() =>
    expect(screen.queryByText(/Some results could not be loaded/)).toBeNull(),
  );
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole('button', { name: 'Kept investigation' }),
  ).toBeTruthy();
});
