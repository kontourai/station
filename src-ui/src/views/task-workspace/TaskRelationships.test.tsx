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
  authority: 'owner',
  current: true,
  linked: true,
  create: vi.fn(),
  update: vi.fn(),
  navigate: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station',
    authorityKey: state.authority,
    isCurrent: () => state.current,
  }),
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
  priority: 'medium',
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
  state.authority = 'owner';
  state.current = true;
  state.linked = true;
});
test('retries the exact atomic creation and opens the returned Task', async () => {
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
  render(view());
  await screen.findByRole('button', { name: 'Retry creation' });
  expect(state.create).toHaveBeenCalledTimes(1);
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
test('clears retained creation on authority change without replay', async () => {
  state.create.mockRejectedValue(new Error('unavailable'));
  const mounted = render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Private draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  state.authority = 'other';
  mounted.rerender(view());
  expect(screen.queryByRole('button', { name: 'Retry creation' })).toBeNull();
  expect(
    (screen.getByLabelText('Subtask title') as HTMLInputElement).value,
  ).toBe('');
  expect(state.create).toHaveBeenCalledTimes(1);
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
    render(view('work-chats'));
    expect(state.update).toHaveBeenCalledTimes(1);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry update' }),
    );
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

test('retired authority cannot resurrect a saved creation when switched back', async () => {
  state.create.mockRejectedValue(new Error('lost acknowledgement'));
  const mounted = render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Private work' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  state.authority = 'another';
  mounted.rerender(view());
  state.authority = 'owner';
  mounted.rerender(view());
  expect(screen.queryByRole('button', { name: 'Retry creation' })).toBeNull();
  expect(state.create).toHaveBeenCalledTimes(1);
});

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
