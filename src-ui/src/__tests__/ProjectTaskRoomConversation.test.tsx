/** @vitest-environment jsdom */
import type { ProjectTaskRoomBrowserRecord } from '@kontourai/station-contracts/project-task-room-browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  realGuard: false,
  records: [] as ProjectTaskRoomBrowserRecord[],
  historyFetching: false,
  historyHasNext: false,
  fetchNext: vi.fn(),
  writable: true,
  stream: 'live',
  continue: vi.fn(),
  keep: vi.fn(),
  openConversation: vi.fn().mockResolvedValue(true),
  stop: vi.fn(),
  running: false,
  failedAnswer: false,
  contextText: '',
  requestRecords: [] as { sessionId: string; prompt: string }[],
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTaskTurnReferencesQuery: () => ({ data: [] }),
  useCreateTaskReferenceMutation: () => ({
    mutateAsync: mocks.keep,
    isPending: false,
  }),
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  continueDelegatedTask: mocks.continue,
  interruptDelegatedTask: mocks.stop,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station',
    authorityKey: 'owner',
    isCurrent: () => true,
  }),
}));
vi.mock('../contexts/open-chats-store', () => ({
  openChatsStore: { openConversation: mocks.openConversation },
}));
vi.mock('../components/chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../hooks/useUnsavedGuard', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hooks/useUnsavedGuard')>();
  return {
    useUnsavedGuard: (dirty: boolean) => {
      const real = actual.useUnsavedGuard(mocks.realGuard && dirty);
      return mocks.realGuard
        ? real
        : { DiscardModal: () => null, guard: (action: () => void) => action() };
    },
  };
});
vi.mock('../workspace-panes/TaskRoomComposer', () => ({
  TaskRoomComposer: ({ writable }: { writable: boolean }) => (
    <textarea aria-label="Message the Task" disabled={!writable} />
  ),
}));
vi.mock('@kontourai/station-sdk/project-task-rooms', () => ({
  useProjectTaskRoomDiscoveryQuery: () => ({
    data: {
      kind: 'existing',
      capabilities: { historyRead: true, messageWrite: mocks.writable },
    },
  }),
  useProjectTaskRoomHistoryQuery: () => ({
    data: { pages: [{ kind: 'available', records: mocks.records }] },
    isFetching: mocks.historyFetching,
    hasNextPage: mocks.historyHasNext,
    fetchNextPage: mocks.fetchNext,
    refetch: vi.fn(),
  }),
  useTaskRoomAgentRequestsQuery: () => ({
    data: {
      records: mocks.requestRecords,
      context: {
        version: 'station.task-room-context/v1',
        digest: 'a'.repeat(64),
        title: 'Brief',
        description: '',
        documentRevision: 'revision-1',
        text: mocks.contextText,
      },
    },
    refetch: vi.fn(),
  }),
}));
vi.mock('../workspace-panes/ProjectTaskRoomContext', () => ({
  useProjectTaskRoomContext: () => ({
    stream: mocks.stream,
    live: {
      participants: mocks.running
        ? [
            {
              publication: 'published',
              actor: { actorId: 'claude', kind: 'agent', label: 'Claude' },
              work: {
                sessionId: 'session-1',
                workState: mocks.failedAnswer ? 'blocked' : 'working',
                workName: mocks.failedAnswer
                  ? "Answer couldn't be posted"
                  : 'Task',
              },
            },
          ]
        : [],
    },
  }),
}));

import { ProjectTaskRoomConversation } from '../workspace-panes/ProjectTaskRoomConversation';

function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectTaskRoomConversation
        taskId="task-1"
        projectSlug="project"
        taskCreatedAt="2026-10-01T00:00:00.000Z"
      />
    </QueryClientProvider>,
  );
}
function record(sequence: number, agent = false): ProjectTaskRoomBrowserRecord {
  return {
    actor: {
      kind: agent ? 'agent' : 'human',
      label: agent ? 'Claude' : 'Alice',
    },
    sequence,
    body: {
      kind: 'human-message',
      text: agent ? 'Answer in markdown' : 'Hello room',
    },
    occurredAt: '2026-10-15T10:04:00.000Z',
    digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
    integrity: 'L0',
    ...(agent
      ? { execution: { sessionId: 'session-1', turnId: `turn-${sequence}` } }
      : {}),
  };
}
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  mocks.realGuard = false;
  mocks.records = [];
  mocks.historyFetching = false;
  mocks.historyHasNext = false;
  mocks.fetchNext.mockReset();
  mocks.requestRecords = [];
  mocks.writable = true;
  mocks.stream = 'live';
  mocks.running = false;
  mocks.failedAnswer = false;
  mocks.contextText = '';
  mocks.keep.mockReset().mockResolvedValue({});
  mocks.continue.mockReset().mockResolvedValue({ sessionId: 'session-1' });
  mocks.openConversation.mockReset().mockResolvedValue(true);
  mocks.stop.mockReset().mockResolvedValue({});
});
test('continues reading toward the newest history after a concurrent refresh settles', async () => {
  mocks.records = [record(1)];
  mocks.historyFetching = true;
  mocks.historyHasNext = true;
  const rendered = mount();
  expect(mocks.fetchNext).not.toHaveBeenCalled();
  mocks.historyFetching = false;
  rendered.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectTaskRoomConversation
        taskId="task-1"
        projectSlug="project"
        taskCreatedAt="2026-10-01T00:00:00.000Z"
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(mocks.fetchNext).toHaveBeenCalledOnce());
});

test('groups consecutive human messages and keeps names, avatars and times', () => {
  mocks.records = [record(1), record(2)];
  mount();
  const list = screen.getByRole('list', { name: 'Task room history' });
  expect(within(list).getAllByText('Alice')).toHaveLength(1);
  expect(list.querySelectorAll('time')).toHaveLength(2);
  expect(list.querySelector('.task-room-avatar')).toBeTruthy();
});
test('agent answers open in the dock, can be kept, and replies continue the exact session in a thread', async () => {
  mocks.records = [record(1, true), record(2, true)];
  mount();
  expect(screen.getAllByText('Answer in markdown')).toHaveLength(1);
  expect(screen.queryByRole('menuitem', { name: 'Open full run' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More answer actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open full run' }));
  expect(mocks.openConversation).toHaveBeenCalledWith('session-1');
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  await waitFor(() =>
    expect(mocks.keep).toHaveBeenCalledWith({
      taskId: 'task-1',
      kind: 'turn',
      sessionId: 'session-1',
      turnId: 'turn-1',
      sourceSurface: 'task-room',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '1 reply' }));
  const thread = screen.getByRole('region', { name: 'Agent thread' });
  expect(within(thread).getAllByText('Answer in markdown')).toHaveLength(2);
  fireEvent.change(within(thread).getByRole('textbox'), {
    target: { value: 'Refine this answer' },
  });
  fireEvent.click(within(thread).getByRole('button', { name: 'Send reply' }));
  await waitFor(() =>
    expect(mocks.continue).toHaveBeenCalledWith(
      'http://station',
      'session-1',
      expect.objectContaining({
        message: 'Refine this answer',
        taskRoomReply: expect.objectContaining({ taskId: 'task-1' }),
      }),
      expect.anything(),
    ),
  );
});
test('running agents have one inline status with functional Watch and Stop', async () => {
  mocks.running = true;
  mount();
  expect(screen.getAllByText('is working')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
  expect(mocks.openConversation).toHaveBeenCalledWith('session-1');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() =>
    expect(mocks.stop).toHaveBeenCalledWith(
      'http://station',
      'session-1',
      {},
      expect.anything(),
    ),
  );
});
test('terminal authorization disables the composer', () => {
  mocks.stream = 'terminal';
  mount();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(
    true,
  );
});

test.each(['task_room_reply_refused', 'receiver_execution_authority_changed'])(
  'a refused exact-session reply stays visibly not delivered (%s)',
  async (code) => {
    mocks.records = [record(1, true)];
    mocks.continue.mockRejectedValue(
      Object.assign(new Error('This Session has a successor.'), { code }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
    const thread = screen.getByRole('region', { name: 'Agent thread' });
    fireEvent.change(within(thread).getByRole('textbox'), {
      target: { value: 'Do not lose this reply' },
    });
    fireEvent.click(within(thread).getByRole('button', { name: 'Send reply' }));
    expect(
      await within(thread).findByText(/Not delivered.*successor/),
    ).toBeTruthy();
    expect(
      (within(thread).getByRole('textbox') as HTMLTextAreaElement).value,
    ).toBe('Do not lose this reply');
    expect(
      within(thread).queryByText('Reply sent to the same agent session.'),
    ).toBeNull();
    fireEvent.click(within(thread).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(mocks.continue).toHaveBeenCalledTimes(2));
    expect(mocks.continue.mock.calls[1][2].taskRoomReply.operationId).toBe(
      mocks.continue.mock.calls[0][2].taskRoomReply.operationId,
    );
  },
);
test('an uncertain reply retains its draft and offers full-run inspection', async () => {
  mocks.records = [record(1, true)];
  mocks.continue.mockRejectedValue(new Error('Connection lost'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
  const thread = screen.getByRole('region', { name: 'Agent thread' });
  fireEvent.change(within(thread).getByRole('textbox'), {
    target: { value: 'Retained reply' },
  });
  fireEvent.click(within(thread).getByRole('button', { name: 'Send reply' }));
  expect(
    await within(thread).findByText(/Not delivered.*Connection lost/),
  ).toBeTruthy();
  expect(
    (within(thread).getByRole('textbox') as HTMLTextAreaElement).readOnly,
  ).toBe(true);
  expect(
    within(thread).getAllByRole('button', { name: 'Open full run' }).length,
  ).toBeGreaterThan(0);
});
test('brief revisions and presence never fill Chat; status changes remain visible and Keep cannot repeat', async () => {
  mocks.records = [
    record(1, true),
    {
      ...record(2),
      system: true,
      body: { kind: 'human-message', text: 'Status → In review' },
    },
    {
      ...record(3),
      body: {
        kind: 'outcome-link',
        link: {
          kind: 'revision',
          stableId: 'revision-1',
          digest: 'a'.repeat(64),
        },
      },
    },
    {
      ...record(4),
      body: { kind: 'live-work-started', sessionId: 'presence-1' },
    },
    {
      ...record(5),
      body: {
        kind: 'live-work-presence-ended',
        sessionId: 'presence-1',
        reason: 'departed',
      },
    },
  ];
  mount();
  expect(screen.getByText('Status → In review')).toBeTruthy();
  expect(screen.queryByText(/shared revision|joined|left/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  const kept = await screen.findByRole('button', { name: 'Kept' });
  expect((kept as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(kept);
  expect(mocks.keep).toHaveBeenCalledTimes(1);
});

test('an unpublished answer remains visible with full-run access when the live turn ends', () => {
  mocks.running = true;
  mocks.failedAnswer = true;
  mount();
  expect(screen.getByText("Answer couldn't be posted ·")).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open full run' }));
  expect(mocks.openConversation).toHaveBeenCalledWith('session-1');
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});
test('long agent answers expand and collapse without opening the full run', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120);
  const answer: ProjectTaskRoomBrowserRecord = {
    ...record(1, true),
    body: { kind: 'human-message', text: 'Detailed answer. '.repeat(80) },
  };
  mocks.records = [answer];
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
  expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
});

test('an accepted turn with an unpublished human reply keeps its visible draft and full-run inspection', async () => {
  mocks.records = [record(1, true)];
  mocks.continue.mockResolvedValue({
    sessionId: 'session-1',
    taskRoomReplyDelivery: 'unpublished',
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
  const thread = screen.getByRole('region', { name: 'Agent thread' });
  fireEvent.change(within(thread).getByRole('textbox'), {
    target: { value: 'Accepted but unposted' },
  });
  fireEvent.click(within(thread).getByRole('button', { name: 'Send reply' }));
  expect(
    await within(thread).findByText(/Not delivered to room.*agent received/),
  ).toBeTruthy();
  expect(
    (within(thread).getByRole('textbox') as HTMLTextAreaElement).value,
  ).toBe('Accepted but unposted');
  expect(
    (within(thread).getByRole('textbox') as HTMLTextAreaElement).readOnly,
  ).toBe(true);
});

test('a shortened brief is disclosed before sending a thread reply and can be detached', () => {
  mocks.records = [record(1, true)];
  mocks.contextText =
    'Plan excerpt. Brief shortened to fit the agent context limit.';
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
  const thread = screen.getByRole('region', { name: 'Agent thread' });
  expect(
    within(thread).getByText(/brief exceeds 16,000 characters/),
  ).toBeTruthy();
  fireEvent.click(
    within(thread).getByRole('checkbox', { name: 'Brief attached' }),
  );
  expect(
    within(thread).queryByText(/brief exceeds 16,000 characters/),
  ).toBeNull();
});

test('Chat filters completed live-work facts while retaining actual conversation messages', () => {
  mocks.records = [
    record(1),
    {
      ...record(2),
      body: {
        kind: 'live-work-finished',
        sessionId: 'session-finished',
        outcome: 'completed',
      },
    },
  ];
  mount();
  const history = screen.getByRole('list', { name: 'Task room history' });
  expect(within(history).getAllByRole('listitem')).toHaveLength(1);
  expect(within(history).getByText('Hello room')).toBeTruthy();
  expect(history.textContent).not.toContain('completed');
});

test('presence-only history shows the room empty state', () => {
  mocks.records = [
    { ...record(1), body: { kind: 'live-work-started', sessionId: 'viewer' } },
    {
      ...record(2),
      body: {
        kind: 'live-work-presence-ended',
        sessionId: 'viewer',
        reason: 'departed',
      },
    },
  ];
  mount();
  expect(screen.getByText('Start the conversation')).toBeTruthy();
});

test('failed agent requests retain a quiet line and retry the original request in the same run', async () => {
  mocks.requestRecords = [
    { sessionId: 'failed-run', prompt: 'Check the settings' },
  ];
  mocks.records = [
    {
      ...record(1, true),
      execution: undefined,
      body: {
        kind: 'live-work-finished',
        sessionId: 'failed-run',
        outcome: 'failed',
      },
    },
  ];
  mount();
  expect(screen.getByText('Claude couldn’t finish')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open run' }));
  expect(mocks.openConversation).toHaveBeenCalledWith('failed-run');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(mocks.continue).toHaveBeenCalledWith(
      'http://station',
      'failed-run',
      expect.objectContaining({ message: 'Check the settings' }),
      expect.anything(),
    ),
  );
});

test('new messages follow only the message scroller and preserve a reader who scrolled up', () => {
  mocks.records = [record(1)];
  const view = mount();
  const list = screen.getByRole('list', { name: 'Task room history' })
    .parentElement!;
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  list.scrollTop = 800;
  fireEvent.scroll(list);
  mocks.records = [record(1), record(2)];
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectTaskRoomConversation
        taskId="task-1"
        projectSlug="project"
        taskCreatedAt="2026-10-01T00:00:00.000Z"
      />
    </QueryClientProvider>,
  );
  expect(list.scrollTop).toBe(1000);
  list.scrollTop = 100;
  fireEvent.scroll(list);
  mocks.records = [record(1), record(2), record(3)];
  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ProjectTaskRoomConversation
        taskId="task-1"
        projectSlug="project"
        taskCreatedAt="2026-10-01T00:00:00.000Z"
      />
    </QueryClientProvider>,
  );
  expect(list.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
  expect(list.scrollTop).toBe(1000);
});

test('thread Enter sends while Shift+Enter and IME keep the reply draft', async () => {
  mocks.records = [record(1, true)];
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));
  const textbox = within(
    screen.getByRole('region', { name: 'Agent thread' }),
  ).getByRole('textbox');
  fireEvent.change(textbox, { target: { value: 'Refine this answer' } });
  fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
  expect(mocks.continue).not.toHaveBeenCalled();
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await waitFor(() => expect(mocks.continue).toHaveBeenCalledOnce());
});

test('answers that fit do not show an expansion control', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120);
  mocks.records = [
    {
      ...record(1, true),
      body: { kind: 'human-message', text: 'A short answer.' },
    },
  ];
  mount();
  expect(screen.getByText('A short answer.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
});

test('cancel retains a thread draft, while confirmed discard cannot carry it to another agent', async () => {
  mocks.realGuard = true;
  const second = record(2, true);
  mocks.records = [
    record(1, true),
    {
      ...second,
      actor: { ...second.actor, label: 'Builder' },
      execution: { sessionId: 'session-2', turnId: 'turn-2' },
    },
  ];
  mount();
  const history = screen.getByRole('list', { name: 'Task room history' });
  fireEvent.click(
    within(history).getAllByRole('button', { name: 'Reply in thread' })[0],
  );
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Reply to this agent' }),
    { target: { value: 'Draft for Claude only' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Reply to this agent',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('Draft for Claude only');
  fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
  fireEvent.click(
    within(history).getAllByRole('button', { name: 'Reply in thread' })[1],
  );
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Reply to this agent',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('');
  expect(
    screen.getByRole('heading', { name: 'Builder · Thread' }),
  ).toBeTruthy();
  expect(mocks.continue).not.toHaveBeenCalled();
});

test('an open thread offers Keep for every answer without navigation back into itself', () => {
  mocks.records = [record(1, true), record(2, true)];
  mount();
  fireEvent.click(screen.getByRole('button', { name: '1 reply' }));
  const thread = screen.getByRole('region', { name: 'Agent thread' });
  expect(
    within(thread).queryByRole('button', {
      name: /^(Reply in thread|\d+ repl(?:y|ies))$/,
    }),
  ).toBeNull();
  expect(within(thread).getAllByRole('button', { name: 'Keep' })).toHaveLength(
    2,
  );
});

test('a pending reply cannot move or discard its thread before settlement', async () => {
  mocks.realGuard = true;
  let complete!: (value: { sessionId: string }) => void;
  mocks.continue.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const other = record(2, true);
  mocks.records = [
    record(1, true),
    {
      ...other,
      actor: { ...other.actor, label: 'Builder' },
      execution: { sessionId: 'session-2', turnId: 'turn-2' },
    },
  ];
  mount();
  const history = screen.getByRole('list', { name: 'Task room history' });
  const choices = within(history).getAllByRole('button', {
    name: 'Reply in thread',
  });
  fireEvent.click(choices[0]);
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Reply to this agent' }),
    { target: { value: 'Reply to Claude' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
  await waitFor(() => expect(mocks.continue).toHaveBeenCalledOnce());
  expect(
    (screen.getByRole('button', { name: 'Close thread' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
  fireEvent.click(choices[1]);
  expect(screen.queryByRole('dialog', { name: 'Unsaved Changes' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Claude · Thread' })).toBeTruthy();
  await act(async () => complete({ sessionId: 'session-1' }));
  fireEvent.click(choices[1]);
  expect(
    screen.getByRole('heading', { name: 'Builder · Thread' }),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Reply to this agent',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('');
});
