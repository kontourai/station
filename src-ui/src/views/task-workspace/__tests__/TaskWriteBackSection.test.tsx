/** @vitest-environment jsdom */
import type { TaskWriteBackEntry } from '@kontourai/station-contracts/task-write-back';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  result: {} as any,
  query: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTaskWriteBackQuery: (...args: unknown[]) => {
    fixture.query(...args);
    return fixture.result;
  },
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://station.test',
    authorityKey: 'task-viewer',
    isCurrent: () => true,
  }),
}));

import { TaskWriteBackSection } from '../TaskWriteBackSection';

const createdAt = '2026-10-01T10:00:00.000Z';
function entry(
  overrides: Partial<TaskWriteBackEntry> = {},
): TaskWriteBackEntry {
  return {
    id: 'first',
    taskId: 'task-1',
    taskCreatedAt: createdAt,
    ordinal: 1,
    target: {
      kind: 'chat',
      system: 'Discord',
      destination: '#release',
      action: 'notify',
    },
    initiatedBy: { kind: 'person', id: 'person-1' },
    attemptedAt: '2026-10-29T12:00:00.000Z',
    retryOf: null,
    state: 'failed',
    failureReason: 'Delivery was refused.',
    settledAt: '2026-10-29T12:00:01.000Z',
    ...overrides,
  };
}

async function openSection() {
  fireEvent.click(screen.getByText('Written to the issue'));
  await waitFor(() =>
    expect(fixture.query).toHaveBeenLastCalledWith(
      'https://station.test',
      'task-1',
      expect.objectContaining({ enabled: true }),
    ),
  );
}

describe('TaskWriteBackSection', () => {
  beforeEach(() => {
    fixture.query.mockReset();
    fixture.refetch.mockReset();
    fixture.result = {
      data: { entries: [] },
      isError: false,
      isFetching: false,
      refetch: fixture.refetch,
    };
  });

  test('loads only on expansion and links the failed attempt to its retry', async () => {
    fixture.result.data.entries = [
      entry(),
      entry({
        id: 'second',
        ordinal: 2,
        retryOf: 'first',
        attemptedAt: '2026-10-29T12:05:00.000Z',
        state: 'pending',
        failureReason: null,
        settledAt: null,
      }),
    ];
    render(<TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />);
    expect(fixture.query).toHaveBeenLastCalledWith(
      'https://station.test',
      'task-1',
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByText('Delivery was refused.')).toBeNull();
    await openSection();
    const first = screen.getByText('Attempt 1').closest('li')!;
    const second = screen.getByText('Attempt 2').closest('li')!;
    expect(within(first).getByText('Failed')).toBeTruthy();
    expect(within(first).getByText('Discord · notify · #release')).toBeTruthy();
    expect(within(first).getByText('Delivery was refused.')).toBeTruthy();
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-29T12:00:00.000Z',
    );
    expect(
      within(first)
        .getByRole('link', { name: 'attempt 2' })
        .getAttribute('href'),
    ).toBe('#task-write-back-attempt-2');
    expect(within(second).getByText('Pending')).toBeTruthy();
    expect(
      within(second)
        .getByRole('link', { name: 'attempt 1' })
        .getAttribute('href'),
    ).toBe('#task-write-back-attempt-1');
  });

  test('shows empty, loading, succeeded, and recoverable error states', async () => {
    const view = render(
      <TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />,
    );
    await openSection();
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy();
    fixture.result = {
      isFetching: true,
      isError: false,
      refetch: fixture.refetch,
    };
    view.rerender(
      <TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />,
    );
    expect(
      screen.getByRole('status', { name: 'Loading write-back history' }),
    ).toBeTruthy();
    fixture.result = {
      data: { entries: [entry({ state: 'succeeded', failureReason: null })] },
      isFetching: false,
      isError: false,
      refetch: fixture.refetch,
    };
    view.rerender(
      <TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />,
    );
    expect(screen.getByText('Succeeded')).toBeTruthy();
    fixture.result = { isError: true, refetch: fixture.refetch };
    view.rerender(
      <TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fixture.refetch).toHaveBeenCalledOnce();
  });

  test('does not render a prior Task incarnation as current history', async () => {
    fixture.result.data.entries = [entry({ taskCreatedAt: 'older-task' })];
    render(<TaskWriteBackSection taskId="task-1" taskCreatedAt={createdAt} />);
    await openSection();
    expect(screen.getByText('Write-back history unavailable')).toBeTruthy();
    expect(screen.queryByText('Delivery was refused.')).toBeNull();
  });
});
