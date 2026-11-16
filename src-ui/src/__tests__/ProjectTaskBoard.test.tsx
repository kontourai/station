/** @vitest-environment jsdom */
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const { useOrchestrationSessionActivityQuery } = vi.hoisted(() => ({
  useOrchestrationSessionActivityQuery: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionActivityQuery,
}));

import { ProjectTaskBoard } from '../components/ProjectTaskBoard';

beforeEach(() => {
  useOrchestrationSessionActivityQuery.mockReset();
  useOrchestrationSessionActivityQuery.mockReturnValue({ data: undefined });
});

function task(
  id: string,
  status: TaskRecord['status'],
  sessionId?: string,
): TaskRecord {
  return {
    id,
    projectId: 'demo',
    title: `Work ${id}`,
    description: '',
    status,
    priority: 'normal',
    createdBy: 'user',
    createdAt: '2026-09-30T12:00:00Z',
    updatedAt: '2026-09-30T12:00:00Z',
    ...(sessionId ? { sessionId } : {}),
  };
}

/** A Session's latest-turn window carrying one plan.updated. */
function planWindow(statuses: string[], lifecycleState: string = 'running') {
  const common = {
    provider: 'acp',
    threadId: 'session-a',
    createdAt: '2026-11-10T12:00:00Z',
    turnId: 'turn-1',
  };
  return {
    data: {
      protocolVersion: 1,
      session: { threadId: 'session-a', lifecycleState },
      events: [
        {
          sequence: 1,
          event: { ...common, eventId: 'e1', method: 'turn.started' },
        },
        {
          sequence: 2,
          event: {
            ...common,
            eventId: 'e2',
            method: 'plan.updated',
            entries: statuses.map((status, index) => ({
              content: `Step ${index + 1}`,
              status,
            })),
          },
        },
      ],
      hasMore: false,
      watermark: 2,
    },
  };
}

test('keeps every recorded work state visible and selects the exact task without starting work', () => {
  const statuses: TaskRecord['status'][] = [
    'todo',
    'ready',
    'triage',
    'in_progress',
    'blocked',
    'review',
    'verification',
    'done',
    'canceled',
  ];
  const tasks: TaskRecord[] = statuses.map((status, index) => ({
    id: `task-${index}`,
    projectId: 'demo',
    title: `Work ${index}`,
    description: index === 4 ? 'Waiting for a product decision' : '',
    status,
    priority: 'normal',
    createdBy: 'user',
    createdAt: '2026-09-30T12:00:00Z',
    updatedAt: '2026-09-30T12:00:00Z',
  }));
  const select = vi.fn();
  render(
    <ProjectTaskBoard
      tasks={tasks}
      selectedTaskId="task-4"
      onSelect={select}
    />,
  );
  expect(
    within(screen.getByRole('region', { name: 'To do' })).getAllByRole(
      'button',
    ),
  ).toHaveLength(3);
  expect(
    within(screen.getByRole('region', { name: 'In review' })).getAllByRole(
      'button',
    ),
  ).toHaveLength(2);
  const blocked = within(
    screen.getByRole('region', { name: 'Blocked' }),
  ).getByRole('button');
  expect(blocked.getAttribute('aria-pressed')).toBe('true');
  expect(blocked.textContent).toContain('Waiting for a product decision');
  expect(screen.getAllByRole('button')).toHaveLength(9);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Done' })).getByRole('button'),
  );
  expect(select).toHaveBeenCalledExactlyOnceWith('task-7');
});

test('names the dispatched Session agent-reported plan progress on the card', () => {
  useOrchestrationSessionActivityQuery.mockImplementation((threadId: string) =>
    threadId === 'session-a'
      ? planWindow([
          'completed',
          'completed',
          'completed',
          'in_progress',
          'pending',
        ])
      : { data: undefined },
  );
  render(
    <ProjectTaskBoard
      tasks={[task('a', 'in_progress', 'session-a'), task('b', 'todo')]}
      selectedTaskId=""
      onSelect={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', {
      name: 'Work a, In progress, Agent-reported plan: 3 of 5 steps done',
    }).textContent,
  ).toContain('Agent plan 3/5');
  // No Session, no plan: nothing at all rather than a 0% bar.
  const plain = screen.getByRole('button', { name: 'Work b, To do' });
  expect(plain.querySelector('.task-plan-progress')).toBeNull();
  expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
    'session-a',
    undefined,
    expect.objectContaining({ enabled: true, refetchInterval: 5_000 }),
  );
  expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
    '',
    undefined,
    expect.objectContaining({ enabled: false }),
  );
});

test('a finished 5/5 plan never moves the Task or changes its status', () => {
  useOrchestrationSessionActivityQuery.mockReturnValue(
    planWindow(Array(5).fill('completed'), 'idle'),
  );
  const select = vi.fn();
  render(
    <ProjectTaskBoard
      tasks={[task('a', 'in_progress', 'session-a')]}
      selectedTaskId=""
      onSelect={select}
    />,
  );
  const card = within(
    screen.getByRole('region', { name: 'In progress' }),
  ).getByRole('button', {
    name: 'Work a, In progress, Agent-reported plan: 5 of 5 steps done',
  });
  expect(card.textContent).toContain('In progress');
  expect(
    within(screen.getByRole('region', { name: 'Done' })).queryAllByRole(
      'button',
    ),
  ).toHaveLength(0);
  expect(select).not.toHaveBeenCalled();
});

test('names a stopped or waiting plan in text, not color alone', () => {
  useOrchestrationSessionActivityQuery.mockImplementation((threadId: string) =>
    threadId === 'session-failed'
      ? planWindow(['completed', 'in_progress', 'pending'], 'failed')
      : planWindow(['completed', 'pending'], 'needs_input'),
  );
  render(
    <ProjectTaskBoard
      tasks={[
        task('f', 'in_progress', 'session-failed'),
        task('w', 'blocked', 'session-waiting'),
      ]}
      selectedTaskId=""
      onSelect={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', {
      name: 'Work f, In progress, Agent-reported plan: 1 of 3 steps done, stopped',
    }).textContent,
  ).toContain('Agent plan 1/3 · Stopped');
  expect(
    screen.getByRole('button', {
      name: 'Work w, Blocked, Agent-reported plan: 1 of 2 steps done, waiting',
    }).textContent,
  ).toContain('Agent plan 1/2 · Waiting');
});

test('shows nothing for an empty plan and skips the read for closed Tasks', () => {
  useOrchestrationSessionActivityQuery.mockReturnValue(planWindow([]));
  render(
    <ProjectTaskBoard
      tasks={[task('e', 'review', 'session-a'), task('d', 'done', 'session-d')]}
      selectedTaskId=""
      onSelect={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Work e, In review' }),
  ).toBeTruthy();
  expect(document.querySelector('.task-plan-progress')).toBeNull();
  expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
    'session-d',
    undefined,
    expect.objectContaining({ enabled: false }),
  );
  expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
    'session-a',
    undefined,
    expect.objectContaining({ enabled: true, refetchInterval: undefined }),
  );
});
