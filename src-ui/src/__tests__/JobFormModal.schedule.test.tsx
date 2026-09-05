/** @vitest-environment jsdom */

import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const agentCatalog = vi.hoisted(() => ({
  agents: [] as EnrichedAgentProjection[],
  /** The READ's state, not the rows: `[]` means both "arriving" and "failed". */
  read: { loaded: true, settled: true, failed: false, retrying: false },
  retry: () => {},
  /** Render the REAL picker, for the cases that are about the picker. */
  useRealPicker: false,
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agentCatalog.agents,
  useAgentsLoaded: () => agentCatalog.read.loaded,
  useAgentCatalogRead: () => ({
    ...agentCatalog.read,
    retry: agentCatalog.retry,
  }),
}));

import { JobFormModal } from '../components/scheduler/JobFormModal';
import {
  formatSchedule,
  scheduleForJob,
  WEEKDAY_MORNING_CRON,
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

/**
 * The stub keeps the other cases' assertions about the FORM readable — but it
 * is also why #1536 D2 passed here while the real picker span forever, so the
 * failed-read case below renders the real one (`unmockAgentPicker`).
 */
vi.mock('../components/scheduler/AgentPicker', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../components/scheduler/AgentPicker')
    >();
  return {
    ...actual,
    AgentPicker: (props: {
      value: string;
      onChange: (slug: string) => void;
    }) =>
      agentCatalog.useRealPicker ? (
        <actual.AgentPicker {...props} />
      ) : (
        <input aria-label="Agent" value={props.value} readOnly />
      ),
  };
});

describe('JobFormModal schedule compatibility', () => {
  beforeEach(() => {
    addMutate.mockReset();
    editMutate.mockReset();
    mutationState.addError = null;
    mutationState.editError = null;
    agentCatalog.agents = [
      { slug: 'station', name: 'Station' } as EnrichedAgentProjection,
    ];
    agentCatalog.read = {
      loaded: true,
      settled: true,
      failed: false,
      retrying: false,
    };
    agentCatalog.retry = () => {};
    agentCatalog.useRealPicker = false;
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

  test('defaults a new job to weekdays 8:00 AM local, not every minute', () => {
    render(<JobFormModal onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'daily-briefing' },
    });
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Summarize my day' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Job' }));

    const submitted = addMutate.mock.calls[0]?.[0];
    // #1536 L1: sent as a SCHEDULE, because a bare `cron` string cannot carry
    // the zone the local expression depends on.
    expect(submitted.schedule).toMatchObject({
      kind: 'cron',
      expr: WEEKDAY_MORNING_CRON,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(submitted.cron).toBeUndefined();
    expect(submitted.schedule.expr).not.toBe('* * * * *');
  });

  test('refuses a new job whose only agent cannot run it', () => {
    agentCatalog.agents = [
      {
        slug: 'claude',
        name: 'Claude Code',
        available: true,
        execution: { agentConnectionId: 'claude' },
      } as EnrichedAgentProjection,
    ];

    render(<JobFormModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'doomed-job' },
    });
    fireEvent.change(screen.getByLabelText('Instructions'), {
      target: { value: 'Never runs' },
    });

    const submit = screen.getByRole('button', { name: 'Add Job' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(addMutate).not.toHaveBeenCalled();
  });

  test('refuses a new job with no instructions', () => {
    render(<JobFormModal onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'empty-job' },
    });

    expect(
      (screen.getByRole('button', { name: 'Add Job' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test('adopts a runnable agent as the default instead of the station literal', () => {
    agentCatalog.agents = [
      {
        slug: 'station',
        name: 'Station',
        available: false,
        unavailableReason: 'No model resolves yet.',
      } as EnrichedAgentProjection,
      { slug: 'reviewer', name: 'Reviewer' } as EnrichedAgentProjection,
    ];

    render(<JobFormModal onClose={vi.fn()} />);

    expect(screen.getByLabelText('Agent')).toHaveProperty('value', 'reviewer');
  });

  /**
   * #1536 H1-2: `useAgents()` is `[]` while the catalog is arriving AND when it
   * failed, so a cold-open Add Job derived "No Agent named 'station'." from an
   * unanswered read and refused to submit — permanently once `/api/agents` had
   * failed, since the app's query defaults are `retry: 1` with no refetch. A
   * message blaming a missing Agent sends the reader to fix the wrong thing.
   */
  describe('an unanswered Agent catalog', () => {
    test('says it is loading rather than naming a missing Agent', () => {
      agentCatalog.agents = [];
      agentCatalog.read = {
        loaded: false,
        settled: false,
        failed: false,
        retrying: false,
      };

      render(<JobFormModal onClose={vi.fn()} />);

      // The shared loading primitive names the wait in its `label`, which lands
      // as the placeholder's accessible name — not as a bespoke sentence.
      expect(screen.getByLabelText('Loading agents')).toBeTruthy();
      expect(screen.queryByText(/No Agent named/)).toBeNull();
    });

    test('does not refuse a new job on a runnability nobody has computed', () => {
      agentCatalog.agents = [];
      agentCatalog.read = {
        loaded: false,
        settled: false,
        failed: false,
        retrying: false,
      };

      render(<JobFormModal onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'cold-open' },
      });
      fireEvent.change(screen.getByLabelText('Instructions'), {
        target: { value: 'Do the thing' },
      });

      expect(
        (screen.getByRole('button', { name: 'Add Job' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    test('names the failed READ, with its retry, when the catalog answered with an error', () => {
      const retry = vi.fn();
      agentCatalog.agents = [];
      agentCatalog.read = {
        loaded: false,
        settled: true,
        failed: true,
        retrying: false,
      };
      agentCatalog.retry = retry;
      // #1536 D2: the REAL picker. With the stub in its place this case passed
      // while the picker itself showed "Loading agents" forever beside this
      // very error — the defect the review found.
      agentCatalog.useRealPicker = true;

      render(<JobFormModal onClose={vi.fn()} />);

      expect(
        screen.getByText(/Station could not load the Agent catalog/),
      ).toBeTruthy();
      expect(screen.queryByText(/No Agent named/)).toBeNull();
      expect(screen.queryByLabelText('Loading agents')).toBeNull();
      expect(screen.queryByText('No runnable agents')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(retry).toHaveBeenCalledTimes(1);
    });

    test('says the retry is in flight instead of inviting a second click', () => {
      // #1536 D7.
      agentCatalog.agents = [];
      agentCatalog.read = {
        loaded: false,
        settled: true,
        failed: true,
        retrying: true,
      };

      render(<JobFormModal onClose={vi.fn()} />);

      const retrying = screen.getByRole('button', { name: 'Trying…' });
      expect((retrying as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });

    test('still refuses a new job once the catalog HAS answered and the agent cannot run', () => {
      // The guard must not swallow the real refusal it was narrowed around.
      agentCatalog.agents = [
        {
          slug: 'claude',
          name: 'Claude Code',
          available: true,
          execution: { agentConnectionId: 'claude' },
        } as EnrichedAgentProjection,
      ];

      render(<JobFormModal onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'doomed' },
      });
      fireEvent.change(screen.getByLabelText('Instructions'), {
        target: { value: 'Never runs' },
      });

      expect(
        (screen.getByRole('button', { name: 'Add Job' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });
});
