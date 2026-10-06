/** @vitest-environment jsdom */
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ProjectTaskBoard } from '../components/ProjectTaskBoard';

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
    within(screen.getByRole('region', { name: 'Backlog' })).getAllByRole(
      'button',
    ),
  ).toHaveLength(3);
  expect(
    within(screen.getByRole('region', { name: 'Review' })).getAllByRole(
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
