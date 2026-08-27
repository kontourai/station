/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const projectTasksSection = vi.fn((_props: unknown) => (
  <div>Canonical project tasks</div>
));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectQuery: () => ({
    data: { workingDirectory: '/workspace/demo', agents: ['planner'] },
  }),
}));

vi.mock('../views/project-page/ProjectTasksSection', () => ({
  ProjectTasksSection: (props: unknown) => projectTasksSection(props),
}));

import { TasksLayout } from '../components/TasksLayout';

test('adapts the existing project task surface instead of creating a task model', () => {
  render(<TasksLayout projectSlug="demo" layoutSlug="tasks" config={{}} />);

  expect(screen.getByText('Canonical project tasks')).toBeTruthy();
  expect(projectTasksSection).toHaveBeenCalledWith(
    expect.objectContaining({
      slug: 'demo',
      projectWorkingDirectory: '/workspace/demo',
      agents: ['planner'],
    }),
  );
});
