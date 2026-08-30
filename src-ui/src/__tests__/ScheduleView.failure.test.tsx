/**
 * @vitest-environment jsdom
 *
 * archive#3252 — the Schedule view used to render one constant banner
 * ("Could not connect to the scheduler service. Check that the server is
 * running.") for every failure of `/jobs` + `/status`, because it read only
 * `isError` and discarded the status and the body. A corrupt ledger answers
 * HTTP 500 with a body naming `station home restore` (archive#3220), and the
 * user was told to check a server that was answering fine.
 *
 * These tests assert the RENDERED TEXT for each case. Three of the four carry
 * power over the defect. The unreachable case pins the transport copy, which
 * the pre-fix hardcoded banner ALSO satisfied — it is a regression pin, not
 * proof. The others each additionally assert the connection advice is ABSENT,
 * which the pre-fix component cannot do: it printed that sentence
 * unconditionally (archive#3252).
 *
 * The error fixtures are not hand-constructed. Each is produced by running the
 * REAL `listJobs` client against the exact response bytes
 * `src-server/routes/operations/scheduler.ts` writes (`{success:false,error}`
 * plus `schedulerErrorStatus(error)`), so a change that stops carrying the
 * status or the body through the client fails here too.
 */

import { listJobs } from '@kontourai/station-sdk/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const schedulerHooks = vi.hoisted(() => ({
  jobs: { data: [], isLoading: false, isError: false, error: null } as {
    data: unknown[];
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  },
  status: {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  },
  runs: [] as Array<Record<string, unknown>>,
}));

const runMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as string | undefined,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../hooks/useScheduler', () => ({
  useSchedulerJobs: () => schedulerHooks.jobs,
  useSchedulerStatus: () => schedulerHooks.status,
  useSchedulerStats: () => ({ data: undefined, isLoading: false }),
  useSchedulerProviders: () => ({ data: [] }),
  useRunsQuery: () => ({
    data: schedulerHooks.runs,
    isLoading: false,
  }),
  useFetchRunOutputRef: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSchedulerEvents: () => ({
    isRunning: () => false,
    markErrorShown: vi.fn(),
    getMissedCount: () => 0,
  }),
  useRunJob: () => runMutation,
  useToggleJob: () => ({ mutate: vi.fn() }),
  useDeleteJob: () => ({ mutate: vi.fn() }),
  // Added when useScheduler gained it and the view adopted it. This
  // factory must name EVERY export the view reaches, so each new hook
  // reds this suite until listed (archive#4292). The partial-mock form
  // vitest suggests does not work here as-is: falling through to the
  // real hooks needs a QueryClientProvider around the render.
  useRestartJobMonitor: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useResolveIndeterminateJobMonitor: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn(), updateParams: vi.fn() }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => toast,
}));

import { ScheduleView } from '../views/ScheduleView';

/** Runs the real client against a real Response and returns what it threw. */
async function schedulerClientErrorFor(
  body: string,
  init: ResponseInit,
): Promise<unknown> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(body, init)) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  try {
    await listJobs('http://localhost:3141');
    throw new Error('expected listJobs to reject');
  } catch (error) {
    return error;
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The transport failure a browser raises when nothing is listening. */
async function transportErrorFor(): Promise<unknown> {
  const fetchMock = vi
    .fn()
    .mockRejectedValue(
      new TypeError('Failed to fetch'),
    ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  try {
    await listJobs('http://localhost:3141');
    throw new Error('expected listJobs to reject');
  } catch (error) {
    return error;
  } finally {
    vi.unstubAllGlobals();
  }
}

function bothQueriesFail(error: unknown) {
  schedulerHooks.jobs = { data: [], isLoading: false, isError: true, error };
  schedulerHooks.status = {
    data: undefined,
    isLoading: false,
    isError: true,
    error,
  };
}

describe('ScheduleView scheduler failure banner (station#3252)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/schedule');
    schedulerHooks.runs = [];
    schedulerHooks.jobs = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    };
    schedulerHooks.status = {
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    };
    runMutation.mutate.mockReset();
    runMutation.isPending = false;
    runMutation.variables = undefined;
    toast.showToast.mockReset();
    posture.kind = 'healthy';
  });

  test('an unreachable server is the only case that gets connection advice', async () => {
    bothQueriesFail(await transportErrorFor());
    render(<ScheduleView />);

    expect(screen.getByText('Scheduler Unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'Could not connect to the scheduler service. Check that the server is running.',
      ),
    ).toBeTruthy();
  });

  test('a 500 naming a repair command shows that command, not connection advice', async () => {
    // The exact body src-server/routes/operations/scheduler.ts writes when a
    // corrupt ledger surfaces (archive#3220).
    const error = await schedulerClientErrorFor(
      JSON.stringify({
        success: false,
        error:
          'The scheduler ledger is corrupt. Run `station home restore` to recover it.',
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
    bothQueriesFail(error);
    render(<ScheduleView />);

    expect(screen.getByText('Scheduler Error')).toBeTruthy();
    expect(
      screen.getByText(
        'The scheduler service answered with HTTP 500: The scheduler ledger is corrupt. Run `station home restore` to recover it.',
      ),
    ).toBeTruthy();
    // The defect this issue is about: advice about a server that answered.
    expect(screen.queryByText(/Check that the server is running/)).toBeNull();
  });

  test('an answered failure with no explanation still refuses to blame the connection', async () => {
    const error = await schedulerClientErrorFor('<html>gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    bothQueriesFail(error);
    render(<ScheduleView />);

    expect(
      screen.getByText(
        'The scheduler service answered with HTTP 502 but gave no reason.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Check that the server is running/)).toBeNull();
  });

  test('when only one query was answered, that answer is what the user reads', async () => {
    // /jobs never reached the server; /status did and explained itself. The
    // answered one is the only error carrying what the server said, so an
    // ordering that just preferred `jobs` would bury the repair instruction.
    schedulerHooks.jobs = {
      data: [],
      isLoading: false,
      isError: true,
      error: await transportErrorFor(),
    };
    schedulerHooks.status = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: await schedulerClientErrorFor(
        JSON.stringify({
          success: false,
          error: 'Scheduler ledger is corrupt. Run `station home restore`.',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    };
    render(<ScheduleView />);

    expect(
      screen.getByText(
        'The scheduler service answered with HTTP 500: Scheduler ledger is corrupt. Run `station home restore`.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Check that the server is running/)).toBeNull();
  });

  test('negative control: a healthy response renders jobs, not a failure banner', () => {
    schedulerHooks.jobs = {
      data: [
        {
          name: 'nightly-digest',
          provider: 'builtin',
          cron: '0 9 * * *',
          enabled: true,
          prompt: 'summarise',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    schedulerHooks.status = {
      data: { providers: { builtin: { running: true, healthy: true } } },
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ScheduleView />);

    expect(screen.getByText('nightly-digest')).toBeTruthy();
    expect(screen.queryByText('Scheduler Error')).toBeNull();
    expect(screen.queryByText('Scheduler Unavailable')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  function seedTwoRunnableJobs() {
    schedulerHooks.jobs = {
      data: [
        {
          name: 'nightly-digest',
          provider: 'builtin',
          cron: '0 9 * * *',
          enabled: true,
          prompt: 'summarise',
        },
        {
          name: 'weekly-report',
          provider: 'builtin',
          cron: '0 9 * * 1',
          enabled: true,
          prompt: 'report',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    schedulerHooks.status = {
      data: { providers: { builtin: { running: true, healthy: true } } },
      isLoading: false,
      isError: false,
      error: null,
    };
  }

  const runButton = (job: string) =>
    screen.getByRole('button', { name: `Run ${job}` }) as HTMLButtonElement;

  const starterRun = (logId: string) => ({
    runId: `schedule:built-in:station-starter-check:${logId}`,
    providerId: 'built-in',
    source: 'schedule',
    sourceId: 'station-starter-check',
    status: 'running',
    startedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    retryEligible: false,
    attempt: 1,
    metadata: { manual: true },
  });

  function seedStarterJob() {
    schedulerHooks.jobs = {
      data: [
        {
          name: 'station-starter-check',
          provider: 'built-in',
          schedule: { kind: 'every', everyMs: 86_400_000 },
          enabled: false,
          prompt: 'check',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
  }

  test('focuses exact Scheduler runs and follows same-view history changes', async () => {
    seedStarterJob();
    const first = starterRun('run-1');
    const second = starterRun('run-2');
    schedulerHooks.runs = [first, second];
    window.history.replaceState({}, '', `/schedule?run=${first.runId}`);
    render(<ScheduleView />);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-run-id')).toBe(
        first.runId,
      ),
    );
    window.history.pushState({}, '', `/schedule?run=${second.runId}`);
    fireEvent(window, new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-run-id')).toBe(
        second.runId,
      ),
    );
    expect(
      document
        .querySelector('.schedule__log--focused')
        ?.getAttribute('tabindex'),
    ).toBe('-1');
  });

  test('renders a durable exact run after its owning job is deleted', async () => {
    const run = starterRun('deleted-job-run');
    schedulerHooks.runs = [run];
    window.history.replaceState({}, '', `/schedule?run=${run.runId}`);
    render(<ScheduleView />);
    expect(screen.getByText('Scheduled check receipt')).toBeTruthy();
    expect(
      screen.getByText('The owning job was removed; its durable run remains.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector('.schedule__log--focused')).toBeTruthy(),
    );
  });

  test('does not substitute another run for a missing exact receipt', () => {
    schedulerHooks.runs = [starterRun('other-run')];
    window.history.replaceState(
      {},
      '',
      '/schedule?run=schedule:built-in:station-starter-check:missing-run',
    );
    render(<ScheduleView />);
    expect(
      screen.getByText(/That scheduled run isn’t available/i),
    ).toBeTruthy();
    // The promise this message exists for: no substitution (archive#3965).
    expect(
      screen.getByText(/won’t open a different one in its place/i),
    ).toBeTruthy();
    expect(document.querySelector('.schedule__log--focused')).toBeNull();
  });

  test('labels an indeterminate Scheduler receipt without calling it failed', async () => {
    seedStarterJob();
    const base = starterRun('indeterminate-run');
    const run = {
      ...base,
      status: 'failed',
      failureKind: 'unknown',
      failureMessage: 'Invocation outcome is indeterminate.',
      metadata: { ...base.metadata, schedulerState: 'indeterminate' },
    };
    schedulerHooks.runs = [run];
    window.history.replaceState({}, '', `/schedule?run=${run.runId}`);
    render(<ScheduleView />);
    await waitFor(() => expect(screen.getByText('Indeterminate')).toBeTruthy());
    expect(
      screen.queryByText('Failed', { selector: '.schedule__status-pill span' }),
    ).toBeNull();
  });

  test('a failed Run now request surfaces its error', () => {
    seedTwoRunnableJobs();
    runMutation.mutate.mockImplementation((_: string, options: any) =>
      options.onError(new Error('Scheduler invocation failed.')),
    );
    render(<ScheduleView />);

    fireEvent.click(runButton('nightly-digest'));
    expect(toast.showToast).toHaveBeenCalledWith(
      "Failed to run 'nightly-digest': Scheduler invocation failed.",
    );
    expect(screen.getByRole('alert').textContent).toBe(
      "Failed to run 'nightly-digest': Scheduler invocation failed.",
    );
  });

  test('starts an explicit run directly', () => {
    seedTwoRunnableJobs();
    render(<ScheduleView />);

    fireEvent.click(runButton('nightly-digest'));
    expect(runMutation.mutate).toHaveBeenCalledWith(
      'nightly-digest',
      expect.any(Object),
    );
  });

  test('a pending Run now disables that job only, not every job', () => {
    seedTwoRunnableJobs();
    const { rerender } = render(<ScheduleView />);
    expect(runButton('nightly-digest').disabled).toBe(false);

    // React Query reports the in-flight mutation's own variables; the button
    // state is scoped to the job that was actually asked to run.
    runMutation.isPending = true;
    runMutation.variables = 'nightly-digest';
    rerender(<ScheduleView />);

    expect(runButton('nightly-digest').disabled).toBe(true);
    expect(runButton('weekly-report').disabled).toBe(false);
  });

  test('an auth failure whose body is an object never renders [object Object]', async () => {
    // The runtime's own auth boundary answers 401/403/429 and the containment
    // 500 with `{ error: { code: … } }` (runtime-http.ts:95, :340, :446), and
    // both scheduler reads are pairing-scope gated — so this is the shape a
    // paired device with a narrower scope actually receives. `error` is
    // DECLARED string and computed by nobody (archive#3252).
    const error = await schedulerClientErrorFor(
      JSON.stringify({ error: { code: 'insufficient_scope' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
    bothQueriesFail(error);
    render(<ScheduleView />);

    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(
      screen.getByText(
        'The scheduler service answered with HTTP 403 but gave no reason.',
      ),
    ).toBeTruthy();
  });
});
