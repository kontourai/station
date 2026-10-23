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
  fetchConversationInventory: async () => ({
    items: [{ id: 'canonical-chat', title: 'Implementation' }],
    hasMore: false,
  }),
}));
vi.mock('@kontourai/station-sdk/client/task-relationships', () => ({
  fetchTaskWorkChat: async () => ({ revision: 4 }),
}));
vi.mock('@kontourai/station-sdk/task-relationships', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useTaskChildrenQuery: () => ({ data: { children: [] } }),
    useTaskWorkChatsQuery: () => ({
      data: {
        chats: state.linked
          ? [{ conversationId: 'canonical-chat', revision: 4 }]
          : [],
      },
    }),
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
function view(kind: 'children' | 'work-chats' = 'children', record = task) {
  return (
    <QueryClientProvider client={new QueryClient()}>
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
    render(view('work-chats'));
    const retry = await screen.findByRole('button', { name: 'Retry update' });
    expect(state.update).toHaveBeenCalledTimes(1);
    state.current = false;
    fireEvent.click(retry);
    expect(state.update).toHaveBeenCalledTimes(1);
    state.current = true;
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
