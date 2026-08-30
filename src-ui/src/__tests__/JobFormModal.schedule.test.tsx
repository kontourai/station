/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { JobFormModal } from '../components/scheduler/JobFormModal';
import {
  formatSchedule,
  scheduleForJob,
} from '../components/scheduler/scheduleValue';

const addMutate = vi.fn();
const editMutate = vi.fn();
const mutationState = vi.hoisted(() => ({
  addError: null as unknown,
  editError: null as unknown,
}));

vi.mock('../hooks/useScheduler', () => ({
  useAddJob: () => ({
    isPending: false,
    mutate: addMutate,
    error: mutationState.addError,
  }),
  useEditJob: () => ({
    isPending: false,
    mutate: editMutate,
    error: mutationState.editError,
  }),
  usePreviewSchedule: () => ({ data: [], isLoading: false }),
}));

vi.mock('../components/scheduler/AgentPicker', () => ({
  AgentPicker: ({ value }: { value: string }) => (
    <input aria-label="Agent" value={value} readOnly />
  ),
}));

describe('JobFormModal schedule compatibility', () => {
  beforeEach(() => {
    addMutate.mockReset();
    editMutate.mockReset();
    mutationState.addError = null;
    mutationState.editError = null;
  });

  test('opens an exact-interval job without converting its schedule to text', () => {
    const job = {
      name: 'monitor-health',
      provider: 'built-in',
      schedule: { kind: 'every' as const, everyMs: 300_000 },
      prompt: 'Check service health',
      agent: 'station',
      enabled: true,
    };

    render(<JobFormModal job={job} onClose={vi.fn()} />);

    expect(
      screen
        .getByRole('button', { name: 'Exact interval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByLabelText('Interval value')).toHaveProperty(
      'value',
      '5',
    );
    expect(screen.getByLabelText('Interval unit')).toHaveProperty(
      'value',
      'minutes',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(editMutate).toHaveBeenCalledWith(
      { target: 'monitor-health' },
      expect.any(Object),
    );
  });

  test('submits a changed one-time schedule as the shared schedule contract', () => {
    const job = {
      name: 'wake-later',
      provider: 'built-in',
      cron: '0 9 * * *',
      prompt: 'Wake up',
      agent: 'station',
      enabled: true,
    };

    render(<JobFormModal job={job} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'One time' }));
    fireEvent.change(screen.getByLabelText('Run once at'), {
      target: { value: '2030-01-02T03:04' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const submitted = editMutate.mock.calls[0]?.[0];
    expect(submitted.target).toBe('wake-later');
    expect(submitted.schedule).toEqual({
      kind: 'at',
      timeMs: new Date('2030-01-02T03:04').getTime(),
      deleteAfterRun: true,
    });
  });

  test('preserves sub-minute one-time precision when another field changes', () => {
    const preciseTime = new Date('2030-01-02T03:04:56.789').getTime();
    const job = {
      name: 'wake-precisely',
      provider: 'built-in',
      schedule: {
        kind: 'at' as const,
        timeMs: preciseTime,
        deleteAfterRun: true,
      },
      prompt: 'Wake up precisely',
      agent: 'station',
      enabled: true,
    };

    render(<JobFormModal job={job} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Wake up precisely with a status check' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(editMutate).toHaveBeenCalledWith(
      {
        target: 'wake-precisely',
        prompt: 'Wake up precisely with a status check',
      },
      expect.any(Object),
    );
  });

  test('preserves sub-minute precision when only deletion behavior changes', () => {
    const preciseTime = new Date('2030-01-02T03:04:56.789').getTime();
    const job = {
      name: 'wake-and-keep',
      provider: 'built-in',
      schedule: {
        kind: 'at' as const,
        timeMs: preciseTime,
        deleteAfterRun: true,
      },
      prompt: 'Wake up precisely',
      agent: 'station',
      enabled: true,
    };

    render(<JobFormModal job={job} onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Delete the job after it runs',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(editMutate).toHaveBeenCalledWith(
      {
        target: 'wake-and-keep',
        schedule: {
          kind: 'at',
          timeMs: preciseTime,
          deleteAfterRun: false,
        },
      },
      expect.any(Object),
    );
  });

  test('removes a monitor explicitly and clears its hidden authority fields', () => {
    const job = {
      name: 'pr-monitor',
      provider: 'built-in',
      cron: '0 9 * * *',
      prompt: 'Observe',
      agent: 'station',
      enabled: true,
      monitor: {
        kind: 'github-pull-request' as const,
        objective: 'review-ready' as const,
        target: 'https://github.com/kontourai/station/pull/4210',
        projectId: 'station',
        agentId: 'station',
        credentialSecretBinding: 'github-token',
        budget: { maxTurns: 2, maxTokens: 200, maxRuntimeMs: 300 },
      },
    };
    render(<JobFormModal job={job} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Monitor type'), {
      target: { value: 'none' },
    });
    expect(screen.queryByLabelText('Monitor target')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(editMutate).toHaveBeenCalledWith(
      { target: 'pr-monitor', monitor: null },
      expect.any(Object),
    );
  });

  test('formats every and one-time jobs instead of leaking object coercion', () => {
    expect(
      formatSchedule(
        scheduleForJob({
          name: 'monitor',
          provider: 'built-in',
          schedule: { kind: 'every', everyMs: 7_200_000 },
          prompt: 'Observe',
          enabled: true,
        }),
      ),
    ).toBe('Every 2 hours');
    expect(
      formatSchedule({ kind: 'at', timeMs: Date.UTC(2030, 0, 2, 3, 4) }),
    ).not.toContain('[object Object]');
  });

  test('renders a duplicate-name conflict without closing the dialog', () => {
    mutationState.addError = new Error("Job 'daily-report' already exists");

    render(
      <JobFormModal
        prefill={{ name: 'daily-report', prompt: 'Duplicate' }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toBe(
      "Job 'daily-report' already exists",
    );
    expect(screen.getByRole('dialog', { name: 'Add Job' })).toBeTruthy();
  });
});
