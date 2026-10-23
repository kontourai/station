/** @vitest-environment jsdom */

import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authority: 'owner',
  current: true,
  create: vi.fn(),
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
      data: { chats: [{ conversationId: 'canonical-chat', revision: 4 }] },
    }),
    useCreateTaskChildMutation: () => useMutation({ mutationFn: state.create }),
    useSetTaskWorkChatMutation: () =>
      useMutation({ mutationFn: async () => ({}) }),
  };
});

import { TaskRelationships } from './TaskRelationships';

const task = {
  id: 'parent',
  createdAt: '2026-10-22',
  projectId: 'project',
} as TaskRecord;
function view(kind: 'children' | 'work-chats' = 'children') {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TaskRelationships task={task} kind={kind} />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.authority = 'owner';
  state.current = true;
});
test('retries the exact atomic creation and opens the returned Task', async () => {
  state.create
    .mockRejectedValueOnce(new Error('lost acknowledgement'))
    .mockResolvedValueOnce({ task: { id: 'created-child' } });
  render(view());
  fireEvent.change(screen.getByLabelText('Subtask title'), {
    target: { value: 'Verify import' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add subtask' }));
  await screen.findByRole('button', { name: 'Retry creation' });
  expect(state.navigate).not.toHaveBeenCalled();
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
