/** @vitest-environment jsdom */

import type {
  TaskProposal,
  TaskRecord,
} from '@kontourai/station-contracts/task-graph';
import { taskQueries } from '@kontourai/station-sdk';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { TaskProposalCard } from '../components/chat/TaskProposalCard';
import { activeChatsStore } from '../contexts/active-chats-store';

const queryClient = new QueryClient();
const host = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  links: [] as {
    sourceType: string;
    targetType: string;
    targetId: string;
    source: string;
    relationType: string;
    sourceId: string;
    metadata: { shapingTurnId: string; proposalBriefSaved?: boolean };
  }[],
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useQueryClient: () => queryClient,
  useSessionRelationsQuery: () => ({ data: { links: host.links } }),
  useCreateTaskMutation: () => ({ mutateAsync: host.create, isPending: false }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: host.navigate }),
}));
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [{ slug: 'alpha', name: 'Alpha' }] }),
}));

const proposal: TaskProposal = {
  title: 'Show installer progress',
  goal: 'People can see which step is running.',
  doneWhen: [
    'Each step shows its count.',
    'Errors keep the current step visible.',
  ],
  firstStep: 'Find the installer step owner.',
};
const approvedBrief =
  '## Goal\n\nPeople can see which step is running.\n\n## Done when\n\n- [ ] Each step shows its count.\n- [ ] Errors keep the current step visible.\n\n## Suggested first step\n\nFind the installer step owner.';
const acceptedTask: TaskRecord = {
  id: 'accepted-task',
  projectId: 'alpha',
  title: 'Show installer progress',
  description: proposal.goal,
  priority: 'normal',
  status: 'todo',
  createdBy: 'user',
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
};
let remoteCatalog: TaskRecord[] = [];
beforeEach(() => {
  host.links = [];
  remoteCatalog = [];

  queryClient.clear();
  queryClient.setQueryDefaults(taskQueries.list('alpha').queryKey, {
    queryFn: async () => remoteCatalog,
  });
  queryClient.setQueryData(taskQueries.list('alpha').queryKey, []);
  host.create.mockReset();
  host.navigate.mockReset();
  host.create.mockImplementation(async () => {
    remoteCatalog = [acceptedTask];
    return acceptedTask;
  });
});

test('a proposal stays provisional until Create Task, then submits its brief and exact source and opens the Task', async () => {
  activeChatsStore.initChat('shape-session', {
    agentSlug: 'station',
    agentName: 'Station',
    title: 'Shaping',
  });
  activeChatsStore.updateChat('shape-session', { taskShaping: true });
  render(
    <TaskProposalCard
      proposal={proposal}
      sessionId="shape-session"
      turnId="shape-turn"
      projectId="alpha"
    />,
  );
  expect(host.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  await waitFor(() => expect(host.navigate).toHaveBeenCalledTimes(1));
  expect(host.create).toHaveBeenCalledWith({
    projectId: 'alpha',
    title: 'Show installer progress',
    createdBy: 'user',
    shapingSource: { sessionId: 'shape-session', turnId: 'shape-turn' },
    description: proposal.goal,
    proposalBrief: approvedBrief,
  });
  expect(host.navigate).toHaveBeenCalledWith('/tasks/accepted-task');
  expect(activeChatsStore.getSnapshot()['shape-session'].taskShaping).toBe(
    false,
  );
  activeChatsStore.removeChat('shape-session');
  expect(queryClient.getQueryData(taskQueries.list('alpha').queryKey)).toEqual([
    acceptedTask,
  ]);
});

test('failed acceptance retains the proposal and does not navigate', async () => {
  host.create.mockRejectedValue(new Error('offline'));
  render(
    <TaskProposalCard
      proposal={proposal}
      sessionId="shape-session"
      turnId="shape-turn"
      projectId="alpha"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText(proposal.title)).toBeTruthy();
  expect(host.navigate).not.toHaveBeenCalled();
});

test('the proposal card shows the goal, Done when checklist and first step', () => {
  render(
    <TaskProposalCard
      proposal={proposal}
      sessionId="session"
      turnId="turn"
      projectId="alpha"
    />,
  );
  expect(
    screen.getByRole('region', { name: 'Task proposal' }).textContent,
  ).toContain('Errors keep the current step visible.');
  expect(
    screen.getByText('People can see which step is running.'),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Suggested first step' }),
  ).toBeTruthy();
});

test('opening a proposal creates no Task before acceptance', () => {
  render(
    <TaskProposalCard
      proposal={proposal}
      sessionId="session"
      turnId="turn"
      projectId="alpha"
    />,
  );
  expect(host.create).not.toHaveBeenCalled();
  expect(host.navigate).not.toHaveBeenCalled();
});

test('a reloaded accepted card opens its linked Task without accepting again', () => {
  host.links = [
    {
      sourceType: 'task',
      targetType: 'session',
      targetId: 'shape-session',
      source: 'user',
      relationType: 'spawned_session',
      sourceId: 'accepted-task',
      metadata: { shapingTurnId: 'shape-turn', proposalBriefSaved: true },
    },
  ];
  render(
    <TaskProposalCard
      proposal={proposal}
      sessionId="shape-session"
      turnId="shape-turn"
      projectId="alpha"
    />,
  );
  expect(screen.getByText('Task proposal · Accepted')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create Task' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
  expect(host.navigate).toHaveBeenCalledWith('/tasks/accepted-task');
  expect(host.create).not.toHaveBeenCalled();
});
