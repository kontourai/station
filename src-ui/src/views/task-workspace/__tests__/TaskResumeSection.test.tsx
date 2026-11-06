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
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  flags: new Set<string>(['task-resume']),
  view: vi.fn(),
  resume: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => fixture.flags,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useDispatchTaskMutation: () => ({ mutateAsync: fixture.dispatch }),
}));
vi.mock('@kontourai/station-sdk/task-resume', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/task-resume')>()),
  readTaskResumeView: fixture.view,
  resumeTask: fixture.resume,
}));

import { TaskResumeError } from '@kontourai/station-sdk/task-resume';
import { toastStore } from '../../../contexts/ToastContext';
import { TaskResumeSection } from '../TaskResumeSection';

const TASK: TaskRecord = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Fix it',
  description: '',
  priority: 'normal',
  status: 'done',
  agentId: 'agent-1',
  createdBy: 'user',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  endedAt: '2026-11-02T00:00:00.000Z',
  sessionId: 'task-session-1',
  workItemRef: 'github:o/r#1',
  workItemProvenance: 'project-board',
};

const VIEW = {
  taskId: TASK.id,
  taskCreatedAt: TASK.createdAt,
  status: 'done',
  endedAt: TASK.endedAt,
  deadline: '2026-11-16T00:00:00.000Z',
  supported: true,
  resumes: 0,
  previousLead: { sessionId: 'task-session-1', owner: 'human:local:alex' },
  followUps: {
    state: 'read',
    total: 1,
    seenThrough: '2026-11-03T00:00:00.000Z',
    items: [
      {
        kind: 'comment',
        itemRef: 'github:o/r#1',
        author: 'reviewer',
        actorClass: 'member',
        association: 'MEMBER',
        occurredAt: '2026-11-03T00:00:00.000Z',
        recordedAt: '2026-11-03T00:00:00.000Z',
        excerpt: 'Please add a test.',
        truncated: false,
      },
    ],
  },
};

function renderSection(task: TaskRecord = TASK) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TaskResumeSection task={task} />
    </QueryClientProvider>,
  );
}

describe('TaskResumeSection (#4554)', () => {
  beforeEach(() => {
    toastStore.clear();
    fixture.flags = new Set(['task-resume']);
    fixture.view.mockReset().mockResolvedValue(VIEW);
    fixture.resume.mockReset().mockResolvedValue({
      task: { ...TASK, status: 'ready' },
      resume: {},
      replayed: false,
    });
    fixture.dispatch.mockReset().mockResolvedValue({});
  });

  test('with the preview off, or on a live Task, nothing is shown and nothing is read', () => {
    fixture.flags = new Set();
    const { container, unmount } = renderSection();
    expect(container.innerHTML).toBe('');
    unmount();
    fixture.flags = new Set(['task-resume']);
    const live = renderSection({ ...TASK, status: 'in_progress' });
    expect(live.container.innerHTML).toBe('');
    expect(fixture.view).not.toHaveBeenCalled();
  });

  test('the ended header shows the deadline and follow-up count; Resume sends the reason with what was shown', async () => {
    renderSection();
    expect(await screen.findByText(/1 follow-up since it ended/)).toBeTruthy();
    expect(screen.getByText(/Resume by/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Please add a test.')).toBeTruthy();
    expect(within(dialog).getByText('human:local:alex')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Resume' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why resume it?'), {
      target: { value: 'Reviewer asked for a test' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(fixture.resume).toHaveBeenCalledTimes(1));
    const [taskId, request] = fixture.resume.mock.calls[0]!;
    expect(taskId).toBe(TASK.id);
    expect(request).toMatchObject({
      expectedCreatedAt: TASK.createdAt,
      expectedEndedAt: TASK.endedAt,
      reason: 'Reviewer asked for a test',
      followUpsSeenThrough: VIEW.followUps.seenThrough,
    });
    expect(request.resumeId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  test('Resume and dispatch makes the dispatch as its own call after the resume', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why resume it?'), {
      target: { value: 'Go again' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Resume and dispatch' }),
    );
    await waitFor(() => expect(fixture.dispatch).toHaveBeenCalledTimes(1));
    expect(fixture.resume).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      taskId: TASK.id,
      dispatch: { agentId: 'agent-1' },
    });
  });

  test('dispatch failure remains visible after the resumed Task removes the section', async () => {
    fixture.dispatch.mockRejectedValueOnce(new Error('Engine unavailable'));
    const { unmount } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why resume it?'), {
      target: { value: 'Go again' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Resume and dispatch' }),
    );
    await screen.findByText(/Resumed, but dispatch failed: Engine unavailable/);
    unmount();
    expect(toastStore.getSnapshot()).toEqual([
      expect.objectContaining({
        message:
          'Task resumed, but dispatch failed. Dispatch it from the Task when ready.',
        type: 'error',
        duration: 0,
      }),
    ]);
  });

  test('a refusal disables Resume and says why; a failed read offers Retry', async () => {
    fixture.view.mockResolvedValueOnce({
      ...VIEW,
      refusal: 'task_resume_expired',
    });
    const { unmount } = renderSection();
    expect(
      await screen.findByText(/More than 14 days have passed/),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    unmount();

    fixture.view.mockRejectedValueOnce(
      new TaskResumeError('task_resume_unavailable', 503, 'down'),
    );
    renderSection();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(await screen.findByText(/1 follow-up since it ended/)).toBeTruthy();
  });

  test('someone who may not resume sees why, not a Resume button', async () => {
    fixture.view.mockRejectedValueOnce(
      new TaskResumeError(
        'task_resume_not_permitted',
        403,
        'Only the Station operator, in person and with access to this Task, can resume it.',
      ),
    );
    renderSection();
    expect(await screen.findByText(/Only the Station operator/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });
});
