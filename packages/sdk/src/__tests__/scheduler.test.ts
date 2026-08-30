import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactQueryMocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  useMutation: vi.fn((options) => options),
  useQuery: vi.fn((options) => options),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: reactQueryMocks.useMutation,
  useQuery: reactQueryMocks.useQuery,
  useQueryClient: vi.fn(() => ({
    invalidateQueries: reactQueryMocks.invalidateQueries,
  })),
}));

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  deleteJob,
  disableJob,
  enableJob,
  getJobLogs,
  getSchedulerStats,
  getSchedulerStatus,
  listSchedulerProviders,
  previewSchedule,
  runJob,
  runJobWithReceipt,
  SchedulerRunFailedError,
  SchedulerRunIndeterminateError,
  updateJob,
} from '../client/scheduler';
import {
  runsQueries,
  useFetchRunOutputRef,
  useRunJob,
  useRunQuery,
  useRunsQuery,
} from '../query-domains/scheduler';

describe('scheduler query domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uses the canonical client for every non-create scheduler operator endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    } as Response);

    const apiBase = 'http://example.test';
    await listSchedulerProviders(apiBase);
    await getSchedulerStats(apiBase);
    await getSchedulerStatus(apiBase);
    await previewSchedule(apiBase, '0 9 * * *', 3);
    await getJobLogs(apiBase, 'daily report', {
      count: 4,
      providerId: 'built-in',
    });
    await updateJob(apiBase, 'daily report', { enabled: false });
    await enableJob(apiBase, 'daily report');
    await disableJob(apiBase, 'daily report');
    await deleteJob(apiBase, 'daily report');

    expect(
      vi.mocked(fetch).mock.calls.map(([input, init]) => [input, init?.method]),
    ).toEqual([
      [`${apiBase}/scheduler/providers`, 'GET'],
      [`${apiBase}/scheduler/stats`, 'GET'],
      [`${apiBase}/scheduler/status`, 'GET'],
      [
        `${apiBase}/scheduler/jobs/preview-schedule?cron=0+9+*+*+*&count=3`,
        'GET',
      ],
      [
        `${apiBase}/scheduler/jobs/daily%20report/logs?count=4&providerId=built-in`,
        'GET',
      ],
      [`${apiBase}/scheduler/jobs/daily%20report`, 'PUT'],
      [`${apiBase}/scheduler/jobs/daily%20report/enable`, 'PUT'],
      [`${apiBase}/scheduler/jobs/daily%20report/disable`, 'PUT'],
      [`${apiBase}/scheduler/jobs/daily%20report`, 'DELETE'],
    ]);
  });

  it('sends monitor removal as an explicit null update', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    } as Response);

    await updateJob('http://example.test', 'daily-report', { monitor: null });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/scheduler/jobs/daily-report',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ monitor: null }),
      }),
    );
  });

  it('fetches runs through the neutral /api/runs surface', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            runId: 'run-1',
            sessionId: 'session-1',
            providerId: 'codex',
            source: 'orchestration',
            engineExecution: 'external',
            status: 'completed',
            startedAt: '2026-04-25T00:00:00.000Z',
            updatedAt: '2026-04-25T00:00:01.000Z',
            retryEligible: false,
            attempt: 1,
            eventCount: 1,
          },
        ],
      }),
    } as Response);

    expect(runsQueries.list().queryKey).toEqual(['runs']);
    await expect(runsQueries.list().queryFn()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-1' }),
    ]);

    expect(fetch).toHaveBeenCalledWith('http://example.test/api/runs', {
      method: 'GET',
    });
  });

  it('#167 iteration-2 (H1): surfaces the server error body on a non-2xx /api/runs failure instead of a generic status message', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'runs backend unavailable' }),
    } as Response);

    await expect(runsQueries.list().queryFn()).rejects.toThrow(
      'runs backend unavailable',
    );
  });

  it('builds a detail query against /api/runs/:id and enables the hook only when an id is present', () => {
    useRunQuery('run-42');

    expect(reactQueryMocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['runs', 'run-42'],
        enabled: true,
      }),
    );

    useRunQuery(null);

    expect(reactQueryMocks.useQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queryKey: ['runs', ''],
        enabled: false,
      }),
    );
  });

  it('passes the neutral runs query factory through useRunsQuery', () => {
    useRunsQuery({ staleTime: 1_000 });

    expect(reactQueryMocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['runs'],
        staleTime: 1_000,
      }),
    );
    expect(reactQueryMocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates scheduler rows and run history after every manual run response', async () => {
    const mutation = useRunJob() as {
      onSettled?: () => void | Promise<void>;
    };

    await mutation.onSettled?.();

    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['scheduler'],
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['runs'],
    });
  });

  it('preserves a manual possible-effect outcome as a non-retryable typed error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        code: 'scheduler_run_indeterminate',
        outcome: 'indeterminate',
        error: 'Scheduler stopped after provider invocation was authorized',
        data: {
          output: 'Scheduler stopped',
          receipt: {
            outcome: 'indeterminate',
            message: 'Scheduler stopped',
            runId: 'schedule:built-in:daily-report:run-1',
          },
        },
      }),
    } as Response);

    const error = await runJob('http://example.test', 'daily-report').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SchedulerRunIndeterminateError);
    expect(error).toMatchObject({
      code: 'scheduler_run_indeterminate',
      outcome: 'indeterminate',
      retryable: false,
      receipt: {
        outcome: 'indeterminate',
        runId: 'schedule:built-in:daily-report:run-1',
      },
    });
  });

  it('preserves an exact failed-run receipt as a typed observable error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        success: false,
        error: 'Scheduler job failed. Inspect the associated run for details.',
        data: {
          output: 'Scheduler job failed.',
          receipt: {
            outcome: 'failed',
            message: 'Scheduler job failed.',
            runId: 'schedule:built-in:daily-report:failed-1',
          },
        },
      }),
    } as Response);

    const error = await runJob('http://example.test', 'daily-report').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SchedulerRunFailedError);
    expect(error).toMatchObject({
      code: 'scheduler_run_failed',
      outcome: 'failed',
      receipt: {
        outcome: 'failed',
        runId: 'schedule:built-in:daily-report:failed-1',
      },
    });
  });

  it('keeps runJob compatible with an older successful output payload', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { output: "Job 'daily-report' completed" },
      }),
    } as Response);

    await expect(
      runJob('http://example.test', 'daily-report'),
    ).resolves.toEqual({
      output: "Job 'daily-report' completed",
    });
  });

  it('reads the additive receipt while retaining the legacy output', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          output: 'Scheduler job completed',
          receipt: {
            outcome: 'completed',
            message: 'Scheduler job completed',
            runId: 'schedule:built-in:daily-report:run-1',
          },
        },
      }),
    } as Response);

    await expect(
      runJobWithReceipt('http://example.test', 'daily-report'),
    ).resolves.toEqual({
      kind: 'received',
      output: 'Scheduler job completed',
      receipt: {
        outcome: 'completed',
        message: 'Scheduler job completed',
        runId: 'schedule:built-in:daily-report:run-1',
      },
    });
  });

  it('does not treat a successful malformed receipt as an observable run', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          output: 'Scheduler job completed',
          receipt: {
            outcome: 'completed',
            message: 'Scheduler job completed',
            runId: '   ',
          },
        },
      }),
    } as Response);

    await expect(
      runJobWithReceipt('http://example.test', 'daily-report'),
    ).resolves.toEqual({
      kind: 'observation-unavailable',
      output: 'Scheduler job completed',
      reason: 'missing_or_invalid_run_receipt',
    });
  });

  it('does not turn a missing indeterminate run identity into a retryable error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        code: 'scheduler_run_indeterminate',
        outcome: 'indeterminate',
        error: 'Scheduler run may have started',
        data: {
          output: 'Scheduler run may have started',
          receipt: {
            outcome: 'indeterminate',
            message: 'Scheduler run may have started',
            runId: '',
          },
        },
      }),
    } as Response);

    const error = await runJob('http://example.test', 'daily-report').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SchedulerRunIndeterminateError);
    expect(error).toMatchObject({
      retryable: false,
      observation: { kind: 'unavailable' },
      receipt: undefined,
    });
  });

  it('reads run output through an opaque output ref', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { content: 'captured output' },
      }),
    } as Response);

    const mutation = useFetchRunOutputRef() as unknown as {
      mutationFn: (ref: {
        source: 'schedule';
        providerId: string;
        runId: string;
        artifactId: string;
        kind: 'text';
      }) => Promise<unknown>;
    };

    await expect(
      mutation.mutationFn({
        source: 'schedule',
        providerId: 'built-in',
        runId: 'run-1',
        artifactId: 'log-1',
        kind: 'text',
      }),
    ).resolves.toEqual({ content: 'captured output' });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/runs/output',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          source: 'schedule',
          providerId: 'built-in',
          runId: 'run-1',
          artifactId: 'log-1',
          kind: 'text',
        }),
      }),
    );
  });
});
