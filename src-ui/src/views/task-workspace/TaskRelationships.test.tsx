/** @vitest-environment jsdom */

import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authority: 'owner-live-1',
  recoveryKey: 'owner',
  current: true,
  linked: true,
  readChats: vi.fn(),
  inventory: vi.fn(),
  candidate: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => {
    const authority = state.authority;
    return {
      apiBase: 'http://station',
      authorityKey: authority,
      draftRecoveryKey: state.recoveryKey,
      isCurrent: () => state.current && authority === state.authority,
    };
  },
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock('../../contexts/open-chats-store', () => ({
  openChatsStore: { openConversation: state.open },
}));
vi.mock('@kontourai/station-sdk', () => ({
  fetchConversationInventory: (...args: unknown[]) => state.inventory(...args),
}));
vi.mock('@kontourai/station-sdk/client/task-relationships', () => ({
  fetchTaskWorkChat: (...args: unknown[]) => state.candidate(...args),
  fetchTaskWorkChats: (...args: unknown[]) => state.readChats(...args),
}));
vi.mock('@kontourai/station-sdk/task-relationships', async (importOriginal) => {
  const { useMutation } = await import('@tanstack/react-query');
  const original =
    await importOriginal<
      typeof import('@kontourai/station-sdk/task-relationships')
    >();
  return {
    ...original,
    useTaskChildrenQuery: () => ({ data: { children: [] } }),
    useCreateTaskChildMutation: () => useMutation({ mutationFn: state.create }),
    useSetTaskWorkChatMutation: () => useMutation({ mutationFn: state.update }),
  };
});

import { navigationStore } from '../../contexts/navigation-store';
import { TaskRelationships } from './TaskRelationships';

const task: TaskRecord = {
  id: 'parent',
  createdAt: '2026-10-22',
  projectId: 'project',
  title: 'Parent',
  description: '',
  priority: 'normal',
  status: 'todo',
  createdBy: 'owner',
  updatedAt: '2026-10-22',
};
function view(
  kind: 'children' | 'work-chats' = 'children',
  record = task,
  client = new QueryClient(),
) {
  return (
    <QueryClientProvider client={client}>
      <TaskRelationships task={record} kind={kind} />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  state.update.mockReset();
  state.create.mockReset();
  state.authority = 'owner-live-1';
  state.recoveryKey = 'owner';
  state.current = true;
  state.linked = true;
  state.readChats.mockReset().mockImplementation(async () => ({
    task: { taskId: task.id, taskCreatedAt: task.createdAt },
    chats: state.linked
      ? [{ conversationId: 'canonical-chat', revision: 4 }]
      : [],
  }));
  state.inventory.mockReset().mockResolvedValue({
    items: [
      { id: 'canonical-chat', title: 'Implementation' },
      { id: 'candidate-chat', title: 'Private candidate' },
    ],
    hasMore: false,
  });
  state.candidate.mockReset().mockResolvedValue({ revision: 4 });
});
test('restores exact creation across a new live activation and opens the returned Task', async () => {
  state.create
    .mockRejectedValueOnce(new Error('lost acknowledgement'))
    .mockResolvedValueOnce({ task: { id: 'created-child' } });
  const mounted = render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Verify import' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  expect(state.navigate).not.toHaveBeenCalled();
  mounted.unmount();
  state.authority = 'owner-live-after-reload';
  render(view());
  await screen.findByRole('button', { name: 'Retry creation' });
  expect(state.create).toHaveBeenCalledTimes(1);
  state.current = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry creation' }));
  expect(state.create).toHaveBeenCalledTimes(1);
  state.current = true;
  fireEvent.click(screen.getByRole('button', { name: 'Retry creation' }));
  await waitFor(() =>
    expect(state.navigate).toHaveBeenCalledWith('/tasks/created-child'),
  );
  expect(state.create.mock.calls[1][0]).toEqual(state.create.mock.calls[0][0]);
  expect(state.create.mock.calls[0][0]).toMatchObject({
    parent: { taskId: 'parent', taskCreatedAt: '2026-10-22' },
    task: { projectId: 'project', title: 'Verify import' },
    operationId: expect.any(String),
  });
});
test('opens canonical linked conversation through the inbox', async () => {
  state.open.mockResolvedValue(true);
  render(view('work-chats'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Implementation' }),
  );
  expect(state.open).toHaveBeenCalledWith(
    'canonical-chat',
    expect.any(Function),
    { revealDock: true },
  );
});

test('a failed relationship refresh withholds cached rows, titles and actions until recovery', async () => {
  const client = new QueryClient();
  render(view('work-chats', task, client));
  await screen.findByRole('button', { name: 'Implementation' });
  fireEvent.change(screen.getByLabelText('Link a chat'), {
    target: { value: 'candidate-chat' },
  });
  state.readChats.mockRejectedValueOnce(new Error('Task access unavailable'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['task-relationships'] });
  });
  await screen.findByText(/Work chats unavailable/);
  expect(
    client
      .getQueryCache()
      .find({ queryKey: ['task-relationships'], exact: false })?.state.data,
  ).toBeTruthy();
  expect(screen.queryByText('Implementation')).toBeNull();
  expect(screen.queryByText('Private candidate')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
  expect(
    (screen.getByLabelText('Link a chat') as HTMLSelectElement).disabled,
  ).toBe(true);
  const link = screen.getByRole('button', { name: 'Link chat' });
  expect((link as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(link);
  expect(state.candidate).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('button', { name: 'Implementation' });
  fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
  await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
});

test('a failed inventory refresh hides cached titles and candidates and blocks mutations until recovery', async () => {
  const client = new QueryClient();
  render(view('work-chats', task, client));
  await screen.findByRole('button', { name: 'Implementation' });
  fireEvent.change(screen.getByLabelText('Link a chat'), {
    target: { value: 'candidate-chat' },
  });
  state.inventory.mockRejectedValueOnce(new Error('Inventory unavailable'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['task-work-chat-candidates'] });
  });
  await screen.findByText(/Chat selection unavailable/);
  expect(
    client
      .getQueryCache()
      .find({ queryKey: ['task-work-chat-candidates'], exact: false })?.state
      .data,
  ).toBeTruthy();
  expect(screen.queryByText('Implementation')).toBeNull();
  expect(screen.queryByText('Private candidate')).toBeNull();
  expect(
    (screen.getByLabelText('Link a chat') as HTMLSelectElement).disabled,
  ).toBe(true);
  for (const name of ['Link chat', 'Unlink']) {
    const button = screen.getByRole('button', { name });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(state.candidate).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry selection' }));
  await screen.findByRole('button', { name: 'Implementation' });
  fireEvent.click(screen.getByRole('button', { name: 'Link chat' }));
  await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  expect(state.update.mock.calls[0][0]).toMatchObject({
    conversationId: 'candidate-chat',
    linked: true,
  });
});

test.each(['task-relationships', 'task-work-chat-candidates'])(
  'a failed %s refresh during link preparation blocks the late mutation',
  async (query) => {
    const client = new QueryClient();
    let resolveCandidate!: (value: { revision: number }) => void;
    state.candidate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCandidate = resolve;
        }),
    );
    render(view('work-chats', task, client));
    await screen.findByRole('option', { name: 'Private candidate' });
    fireEvent.change(screen.getByLabelText('Link a chat'), {
      target: { value: 'candidate-chat' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link chat' }));
    await waitFor(() => expect(state.candidate).toHaveBeenCalledTimes(1));
    const read =
      query === 'task-relationships' ? state.readChats : state.inventory;
    read.mockRejectedValueOnce(new Error('Fresh access unavailable'));
    await act(async () => {
      await client.refetchQueries({ queryKey: [query] });
    });
    await screen.findByText(
      query === 'task-relationships'
        ? /Work chats unavailable/
        : /Chat selection unavailable/,
    );
    await act(async () => resolveCandidate({ revision: 4 }));
    expect(state.update).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry update' })).toBeNull();
  },
);

test.each(['children', 'work-chats'] as const)(
  'storage failure blocks %s mutation',
  async (kind) => {
    const mounted = render(view(kind));
    const storage = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('full');
      });
    try {
      if (kind === 'children') {
        fireEvent.change(screen.getByLabelText('Subtask title'), {
          target: { value: 'Do work' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
      } else
        fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
      await screen.findByText(/Could not save this change/);
      expect(state.create).not.toHaveBeenCalled();
      expect(state.update).not.toHaveBeenCalled();
    } finally {
      storage.mockRestore();
      mounted.unmount();
    }
  },
);

test.each([true, false])(
  'restores an unconfirmed chat change (linked=%s) for manual exact retry after reload',
  async (linked) => {
    state.linked = !linked;
    state.update
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce({});
    const mounted = render(view('work-chats'));
    if (linked) {
      await screen.findByRole('option', { name: 'Implementation' });
      fireEvent.change(screen.getByLabelText('Link a chat'), {
        target: { value: 'canonical-chat' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Link chat' }));
    } else
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await screen.findByRole('button', { name: 'Retry update' });
    mounted.unmount();
    state.authority = 'owner-live-after-reload';
    const client = new QueryClient();
    render(view('work-chats', task, client));
    const retry = await screen.findByRole('button', { name: 'Retry update' });
    await screen.findByText('Implementation');
    expect(state.update).toHaveBeenCalledTimes(1);
    state.current = false;
    fireEvent.click(retry);
    expect(state.update).toHaveBeenCalledTimes(1);
    state.current = true;
    for (const [query, read, alert] of [
      ['task-relationships', state.readChats, /Work chats unavailable/],
      [
        'task-work-chat-candidates',
        state.inventory,
        /Chat selection unavailable/,
      ],
    ] as const) {
      read.mockRejectedValueOnce(new Error('Fresh access unavailable'));
      await act(async () => {
        await client.refetchQueries({ queryKey: [query] });
      });
      await screen.findByText(alert);
      expect(
        (
          screen.getByRole('button', {
            name: 'Retry update',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Retry update' }));
      expect(state.update).toHaveBeenCalledTimes(1);
      await act(async () => {
        await client.refetchQueries({ queryKey: [query] });
      });
      await waitFor(() =>
        expect(
          (
            screen.getByRole('button', {
              name: 'Retry update',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      expect(state.update).toHaveBeenCalledTimes(1);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Retry update' }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls[1][0]).toEqual(
      state.update.mock.calls[0][0],
    );
    expect(state.update.mock.calls[1][0]).toMatchObject({
      linked,
      expectedRevision: 4,
      conversationId: 'canonical-chat',
    });
  },
);

test.each(['children', 'work-chats'] as const)(
  'a late %s success from the previous activation cannot settle its restored retry',
  async (kind) => {
    let complete!: (result: { task: { id: string } }) => void;
    const mutation = kind === 'children' ? state.create : state.update;
    mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const mounted = render(view(kind));
    if (kind === 'children') {
      fireEvent.change(screen.getByLabelText('Subtask title'), {
        target: { value: 'Pending work' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
    } else
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    state.authority = 'owner-live-next';
    mounted.rerender(view(kind));
    const retry = kind === 'children' ? 'Retry creation' : 'Retry update';
    await screen.findByRole('button', { name: retry });
    await act(async () => complete({ task: { id: 'created-child' } }));
    expect(screen.getByRole('button', { name: retry })).toBeTruthy();
    expect(state.navigate).not.toHaveBeenCalled();
    mounted.unmount();
    render(view(kind));
    expect(screen.getByRole('button', { name: retry })).toBeTruthy();
    expect(mutation).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['credential', 'children'],
  ['account', 'children'],
  ['credential', 'work-chats'],
  ['account', 'work-chats'],
] as const)(
  'a changed %s retires the saved %s intent even when switched back',
  async (change, kind) => {
    state.create.mockRejectedValue(new Error('lost acknowledgement'));
    state.update.mockRejectedValue(new Error('lost acknowledgement'));
    const mounted = render(view(kind));
    const retry = kind === 'children' ? 'Retry creation' : 'Retry update';
    if (kind === 'children') {
      fireEvent.change(screen.getByLabelText('Subtask title'), {
        target: { value: 'Private work' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
    } else
      fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    await screen.findByRole('button', { name: retry });
    state.authority = `${change}-live`;
    state.recoveryKey = `${change}-recovery`;
    mounted.rerender(view(kind));
    expect(screen.queryByRole('button', { name: retry })).toBeNull();
    if (kind === 'children')
      expect(
        (screen.getByLabelText('Subtask title') as HTMLInputElement).value,
      ).toBe('');
    mounted.unmount();
    state.authority = 'owner-live-after-return';
    state.recoveryKey = 'owner';
    render(view(kind));
    expect(screen.queryByRole('button', { name: retry })).toBeNull();
    expect(state.create).toHaveBeenCalledTimes(kind === 'children' ? 1 : 0);
    expect(state.update).toHaveBeenCalledTimes(kind === 'work-chats' ? 1 : 0);
  },
);

test('title drafts guard real navigation and reject overlong submissions', async () => {
  navigationStore.navigate('/tasks/parent');
  render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'x'.repeat(241) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  expect(state.create).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Subtask title').getAttribute('maxlength')).toBe(
    '240',
  );
  act(() => navigationStore.navigate('/tasks/elsewhere'));
  expect(await screen.findByRole('button', { name: 'Discard' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
});

test('retires a saved child when the same Task id has a new incarnation', async () => {
  state.create.mockRejectedValue(new Error('lost acknowledgement'));
  const mounted = render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Old work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  mounted.rerender(view('children', { ...task, createdAt: '2026-10-23' }));
  mounted.rerender(view());
  expect(screen.queryByRole('button', { name: 'Retry creation' })).toBeNull();
  expect(state.create).toHaveBeenCalledTimes(1);
});

test('an unconfirmed chat update guards navigation and stopping retries explains uncertainty', async () => {
  state.update.mockRejectedValue(new Error('lost acknowledgement'));
  navigationStore.navigate('/tasks/parent');
  render(view('work-chats'));
  fireEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
  await screen.findByRole('button', { name: 'Retry update' });
  expect(screen.getByText(/may already have been applied/)).toBeTruthy();
  act(() => navigationStore.navigate('/tasks/elsewhere'));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop retrying' }));
  expect(screen.queryByRole('button', { name: 'Retry update' })).toBeNull();
  expect(state.update).toHaveBeenCalledTimes(1);
});

test('a different Task retires both panels even across page unmounts', async () => {
  state.create.mockRejectedValue(new Error('lost acknowledgement'));
  const mounted = render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Old work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  mounted.unmount();
  const other = render(view('work-chats', { ...task, id: 'other-task' }));
  other.unmount();
  render(view());
  expect(screen.queryByRole('button', { name: 'Retry creation' })).toBeNull();
  expect(state.create).toHaveBeenCalledTimes(1);
});

test.each(['counterfeit', 'overlong', 'wrong-parent'])(
  'rejects invalid retained child input: %s',
  async (change) => {
    state.create.mockRejectedValue(new Error('lost acknowledgement'));
    const mounted = render(view());
    fireEvent.change(screen.getByLabelText('Subtask title'), {
      target: { value: 'Saved work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
    await screen.findByRole('button', { name: 'Retry creation' });
    mounted.unmount();
    const key = 'station-task-relationship:children';
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (change === 'counterfeit') saved.input.task.createdBy = 'owner';
    if (change === 'overlong') saved.input.task.title = 'x'.repeat(241);
    if (change === 'wrong-parent')
      saved.input.parent.taskCreatedAt = 'different';
    sessionStorage.setItem(key, JSON.stringify(saved));
    render(view());
    expect(screen.queryByRole('button', { name: 'Retry creation' })).toBeNull();
    expect(state.create).toHaveBeenCalledTimes(1);
  },
);
