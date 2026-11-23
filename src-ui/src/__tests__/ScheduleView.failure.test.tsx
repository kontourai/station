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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  /** Week forecast reads by week start; absent: the job list, forecast empty. */
  weeks: {} as Record<
    string,
    { data: unknown[] | undefined; isLoading: boolean; isError: boolean }
  >,
}));
const weekReads = vi.hoisted(() => vi.fn());

const loadOutput = vi.hoisted(() => vi.fn());
const runMutation = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as string | undefined,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const toggleMutation = vi.hoisted(() => ({ mutate: vi.fn() }));
const retryQueries = vi.hoisted(() => ({
  jobs: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => null,
}));

// The reader's zone, pinned so day boundaries do not depend on the machine.
vi.mock('../components/scheduler/scheduleValue', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../components/scheduler/scheduleValue')
    >();
  return {
    ...original,
    browserTimeZone: () => 'UTC',
    localCronSchedule: (expr: string, zone = 'UTC') =>
      original.localCronSchedule(expr, zone),
    weekdayMorningSchedule: (zone = 'UTC') =>
      original.weekdayMorningSchedule(zone),
  };
});

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [
    { slug: 'helper', name: 'Release helper', engineDisplayName: 'Codex' },
  ],
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [{ id: 'project-1', slug: 'notes', name: 'Notes API' }],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

vi.mock('../hooks/useScheduler', () => ({
  useSchedulerJobs: (weekStart?: string, zone?: string) => {
    if (weekStart === undefined)
      return { ...schedulerHooks.jobs, refetch: retryQueries.jobs };
    weekReads(weekStart, zone);
    return {
      ...(schedulerHooks.weeks[weekStart] ?? {
        data: schedulerHooks.jobs.data.map((job) => ({
          ...(job as object),
          weekOccurrences: { times: [], truncated: false },
        })),
        isLoading: false,
        isError: false,
      }),
      refetch: vi.fn(),
    };
  },
  useSchedulerStatus: () => ({
    ...schedulerHooks.status,
    refetch: retryQueries.status,
  }),
  useSchedulerStats: () => ({ data: undefined, isLoading: false }),
  useSchedulerProviders: () => ({ data: [] }),
  useRunsQuery: () => ({
    data: schedulerHooks.runs,
    isLoading: false,
  }),
  useFetchRunOutputRef: () => ({
    mutate: loadOutput,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useSchedulerEvents: () => ({
    isRunning: () => false,
    markErrorShown: vi.fn(),
    getMissedCount: () => 0,
  }),
  useRunJob: () => runMutation,
  useToggleJob: () => toggleMutation,
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
  useNavigationActions: () => ({ navigate: vi.fn() }),
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

/** Opens an automation's ⋯ menu and returns its Run now item. */
function runNow(label: string): HTMLButtonElement {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }));
  return screen.getByRole('menuitem', { name: 'Run now' }) as HTMLButtonElement;
}

function closeMenu() {
  fireEvent.keyDown(document, { key: 'Escape' });
}

describe('ScheduleView scheduler failure banner (station#3252)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/schedule');
    schedulerHooks.runs = [];
    schedulerHooks.weeks = {};
    weekReads.mockReset();
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
    loadOutput.mockReset();
    runMutation.mutate.mockReset();
    runMutation.isPending = false;
    runMutation.variables = undefined;
    toast.showToast.mockReset();
    retryQueries.jobs.mockReset();
    retryQueries.status.mockReset();
  });

  test('keeps a healthy Run now action beside the damaged-row notice', () => {
    schedulerHooks.jobs.data = [
      {
        name: 'healthy',
        enabled: true,
        provider: 'built-in',
        prompt: 'fixture',
      },
    ];
    schedulerHooks.status.data = {
      providers: {
        'built-in': {
          running: true,
          rowIssues: [
            { jobId: 'damaged-id', name: 'broken', reason: 'invalid-json' },
          ],
        },
      },
    };
    render(<ScheduleView />);
    expect(screen.getByText('Schedules that need repair')).toBeTruthy();
    expect(screen.getByText(/cannot be decoded/)).toBeTruthy();
    fireEvent.click(runNow('healthy'));
    expect(runMutation.mutate).toHaveBeenCalledWith(
      'healthy',
      expect.any(Object),
    );
  });

  test('retries both failed scheduler reads and returns to the job list after recovery', async () => {
    bothQueriesFail(await transportErrorFor());
    let resolveJobs!: () => void;
    const jobsPromise = new Promise<void>((resolve) => {
      resolveJobs = resolve;
    });
    const jobsRequest = { promise: jobsPromise, resolve: resolveJobs };
    let resolveStatus!: () => void;
    const statusPromise = new Promise<void>((resolve) => {
      resolveStatus = resolve;
    });
    const statusRequest = { promise: statusPromise, resolve: resolveStatus };
    retryQueries.jobs.mockReturnValue(jobsRequest.promise);
    retryQueries.status.mockReturnValue(statusRequest.promise);
    const { rerender } = render(<ScheduleView />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(retryQueries.jobs).toHaveBeenCalledTimes(1);
    expect(retryQueries.status).toHaveBeenCalledTimes(1);

    schedulerHooks.jobs = {
      data: [],
      isLoading: true,
      isError: false,
      error: null,
    };
    schedulerHooks.status = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    };
    rerender(<ScheduleView />);
    expect(screen.getByText('Scheduler Unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBe(retry);
    expect(retry.hasAttribute('disabled')).toBe(true);

    await act(async () => jobsRequest.resolve());
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Scheduler Unavailable')).toBeTruthy();

    seedTwoRunnableJobs();
    await act(async () => statusRequest.resolve());
    expect(screen.getByText('nightly-digest')).toBeTruthy();
    expect(screen.queryByText('Scheduler Unavailable')).toBeNull();
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

  test('orders automations by the name people read, not the slug, paused last', () => {
    schedulerHooks.jobs.data = [
      {
        name: 'aaa-sort',
        displayName: 'Zebra report',
        provider: 'built-in',
        enabled: true,
        prompt: 'z',
      },
      {
        name: 'zzz-sort',
        displayName: 'Apple report',
        provider: 'built-in',
        enabled: true,
        prompt: 'a',
      },
      {
        name: 'aa-paused',
        displayName: 'Aardvark report',
        provider: 'built-in',
        enabled: false,
        prompt: 'p',
      },
    ];
    render(<ScheduleView />);
    const names = screen
      .getAllByTestId(/^job-row-/)
      .map((row) => row.querySelector('.automations-row__name')?.textContent);
    expect(names).toEqual(['Apple report', 'Zebra report', 'Aardvark report']);
    // Every row, its disclosure and its menu say the display name.
    expect(
      screen.getByRole('button', { name: 'Actions for Zebra report' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zebra report' })).toBeTruthy();
    expect(screen.queryByText(/aaa-sort|zzz-sort|aa-paused/)).toBeNull();
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
    expect(screen.getByRole('heading', { name: 'Scheduled run' })).toBeTruthy();
    expect(
      screen.getByText('The job was removed, but this run was kept.'),
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
    expect(screen.getByText('That run is no longer available.')).toBeTruthy();
    expect(document.querySelector('.schedule__log--focused')).toBeNull();
  });

  test.each([
    'schedule:%E0%A4%A:station-starter-check:missing-run',
    'schedule:built-in:%E0%A4%A:missing-run',
    'schedule:built-in:station-starter-check:%E0%A4%A',
  ])('keeps the page usable for a malformed run link: %s', (runId) => {
    seedTwoRunnableJobs();
    schedulerHooks.runs = [starterRun('other-run')];
    window.history.replaceState(
      {},
      '',
      `/automations?run=${encodeURIComponent(runId)}`,
    );

    render(<ScheduleView />);

    expect(screen.getByText(/That run is no longer available/i)).toBeTruthy();
    expect(screen.getByText('nightly-digest')).toBeTruthy();
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

    fireEvent.click(runNow('nightly-digest'));
    expect(toast.showToast).toHaveBeenCalledWith(
      "Failed to run 'nightly-digest': Try again in a moment.",
    );
    expect(screen.getByRole('alert').textContent).toBe(
      "Failed to run 'nightly-digest': Try again in a moment.",
    );
  });

  test('starts an explicit run directly', () => {
    seedTwoRunnableJobs();
    render(<ScheduleView />);

    fireEvent.click(runNow('nightly-digest'));
    expect(runMutation.mutate).toHaveBeenCalledWith(
      'nightly-digest',
      expect.any(Object),
    );
  });

  test('a pending Run now disables that job only, not every job', () => {
    seedTwoRunnableJobs();
    const { rerender } = render(<ScheduleView />);
    expect(runNow('nightly-digest').disabled).toBe(false);
    closeMenu();

    // React Query reports the in-flight mutation's own variables; the button
    // state is scoped to the job that was actually asked to run.
    runMutation.isPending = true;
    runMutation.variables = 'nightly-digest';
    rerender(<ScheduleView />);

    expect(runNow('nightly-digest').disabled).toBe(true);
    closeMenu();
    expect(runNow('weekly-report').disabled).toBe(false);
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

describe('Automations list (first-release automations-inbox-01 and -02)', () => {
  const healthy = {
    data: { providers: { 'built-in': { running: true, healthy: true } } },
    isLoading: false,
    isError: false,
    error: null,
  };

  beforeEach(() => {
    window.history.replaceState({}, '', '/automations');
    schedulerHooks.runs = [];
    schedulerHooks.weeks = {};
    weekReads.mockReset();
    schedulerHooks.status = { ...healthy };
    schedulerHooks.jobs = {
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    };
  });

  function job(overrides: Record<string, unknown>) {
    return {
      name: 'digest',
      provider: 'built-in',
      enabled: true,
      prompt: 'Summarize',
      schedule: { kind: 'cron', expr: '0 8 * * 1-5', timezone: 'UTC' },
      ...overrides,
    };
  }

  test('loading shows one skeleton for the page', () => {
    schedulerHooks.jobs = {
      data: [],
      isLoading: true,
      isError: false,
      error: null,
    };
    render(<ScheduleView />);
    expect(
      screen.getByRole('status', { name: 'Loading automations' }),
    ).toBeTruthy();
    expect(screen.queryByText('An agent, a task, a time')).toBeNull();
  });

  test('with none, the page explains an automation, offers the four templates and two chat examples', () => {
    render(<ScheduleView />);
    expect(
      screen.getByRole('heading', { name: 'An agent, a task, a time' }),
    ).toBeTruthy();
    const parts = screen.getByRole('list', { name: 'For example' });
    expect(within(parts).getAllByRole('listitem')).toHaveLength(3);
    for (const [name, text, when] of [
      [
        'Daily repo digest',
        'Merged commits, open pull requests and failing checks since the last run.',
        'Weekdays at 8:00 AM',
      ],
      [
        'Check back on open work',
        'Goes back over open work in a chat: what is unfinished and what should happen next.',
        'Weekdays at 4:00 PM',
      ],
      [
        'Weekly dependency check',
        "Updates and security advisories for a project's dependencies, most urgent first.",
        'Mondays at 9:00 AM',
      ],
      [
        'Stale pull requests',
        'Pull requests with no activity for a week, with a next step for each.',
        'Fridays at 2:00 PM',
      ],
    ])
      expect(
        screen.getByRole('button', { name: new RegExp(`^${name}`) })
          .textContent,
      ).toBe(`${name}${text} ${when}`);
    expect(
      screen.getByText(/Every morning, tell me which tests failed/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Remind me Friday to review open pull requests/),
    ).toBeTruthy();
    // No tiles, tabs or table chrome on an empty page.
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText(/success rate|total runs/i)).toBeNull();
  });

  test('a row says the schedule, the next run, recent outcomes, status and who runs it', () => {
    schedulerHooks.jobs.data = [
      job({
        displayName: 'Daily repo digest',
        target: { kind: 'dedicated', agent: 'helper' },
        nextRun: '2026-11-23T08:00:00.000Z',
        lastRun: '2026-11-20T08:00:00.000Z',
        recentOutcomes: {
          outcomes: ['worked', 'skipped', 'worked', 'failed', 'unknown'],
          more: true,
        },
      }),
    ];
    render(<ScheduleView />);
    const row = screen.getByTestId('job-row-digest');
    expect(
      within(row).getByText('Release helper · Codex · its own chat'),
    ).toBeTruthy();
    expect(within(row).getByText(/^Weekdays at 8:00 AM/)).toBeTruthy();
    expect(within(row).getByText(/^Next: /)).toBeTruthy();
    expect(
      within(row).getByRole('img', {
        name: 'Last 5 runs: 2 worked, 1 failed, 1 skipped, 1 outcome unknown',
      }).children,
    ).toHaveLength(5);
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).queryByRole('alert')).toBeNull();
    // The legend names Unknown only because a row shows one.
    expect(
      within(screen.getByRole('list', { name: 'Run outcomes' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Worked', 'Failed', 'Skipped', 'Unknown']);
  });

  test('outcomes the list read did not carry are unknown, not "no runs"', () => {
    schedulerHooks.jobs.data = [
      job({ name: 'older-host' }),
      job({ name: 'never-ran', recentOutcomes: { outcomes: [], more: false } }),
    ];
    render(<ScheduleView />);
    expect(
      within(screen.getByTestId('job-row-older-host')).getByText(
        'Recent runs unknown',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('job-row-never-ran')).getByText('No runs yet'),
    ).toBeTruthy();
  });

  test('failures are a flag beside Active; Station pausing itself is a flag beside Paused', () => {
    schedulerHooks.jobs.data = [
      job({ name: 'failing', consecutiveFailures: 2 }),
      job({
        name: 'self-paused',
        enabled: false,
        consecutiveFailures: 5,
        pausedItself: { failures: 5, at: '2026-11-22T02:00:00.000Z' },
      }),
      job({ name: 'person-paused', enabled: false }),
    ];
    render(<ScheduleView />);
    const failing = screen.getByTestId('job-row-failing');
    expect(within(failing).getByText(/Last 2 runs failed/)).toBeTruthy();
    expect(within(failing).getByText('Active')).toBeTruthy();
    const selfPaused = screen.getByTestId('job-row-self-paused');
    expect(
      within(selfPaused).getByText(/Paused itself after 5 failed runs/),
    ).toBeTruthy();
    expect(within(selfPaused).queryByText(/runs failed/)).toBeNull();
    expect(within(selfPaused).getByText('Paused')).toBeTruthy();
    expect(within(selfPaused).getByText("Won't run while paused")).toBeTruthy();
    const personPaused = screen.getByTestId('job-row-person-paused');
    expect(within(personPaused).getByText('Paused')).toBeTruthy();
    expect(within(personPaused).queryByText(/Paused itself/)).toBeNull();
  });

  test('the row menu holds Run now, Pause, Edit, Duplicate and Delete; Pause and Resume toggle', () => {
    const toggle = vi.fn();
    toggleMutation.mutate = toggle;
    schedulerHooks.jobs.data = [
      job({ name: 'on', displayName: 'On job' }),
      job({ name: 'off', displayName: 'Off job', enabled: false }),
    ];
    render(<ScheduleView />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for On job' }));
    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual(['Run now', 'Pause', 'Edit', 'Duplicate', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(toggle).toHaveBeenCalledWith({ target: 'on', enabled: false });
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for Off job' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }));
    expect(toggle).toHaveBeenCalledWith({ target: 'off', enabled: true });
    // Status is a word, not a control.
    expect(screen.queryByRole('button', { name: /^(on|off)$/i })).toBeNull();
  });

  test('deleting asks first, naming the display name', () => {
    schedulerHooks.jobs.data = [job({ displayName: 'Daily briefing' })];
    render(<ScheduleView />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for Daily briefing' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(
      screen.getByText("Delete 'Daily briefing'? This cannot be undone."),
    ).toBeTruthy();
  });

  test('the filter appears only past 15 automations', () => {
    schedulerHooks.jobs.data = Array.from({ length: 15 }, (_, index) =>
      job({ name: `job-${index}`, displayName: `Report ${index}` }),
    );
    const { unmount } = render(<ScheduleView />);
    expect(screen.queryByPlaceholderText('Filter automations…')).toBeNull();
    unmount();
    schedulerHooks.jobs.data = Array.from({ length: 16 }, (_, index) =>
      job({ name: `job-${index}`, displayName: `Report ${index}` }),
    );
    render(<ScheduleView />);
    fireEvent.change(screen.getByPlaceholderText('Filter automations…'), {
      target: { value: 'Report 12' },
    });
    expect(screen.getAllByTestId(/^job-row-/)).toHaveLength(1);
  });

  test('a stopped scheduler is a notice, and a healthy one says nothing', () => {
    schedulerHooks.jobs.data = [job({})];
    schedulerHooks.status = {
      ...healthy,
      data: { providers: { 'built-in': { running: false, healthy: false } } },
    };
    const { unmount } = render(<ScheduleView />);
    expect(
      screen.getByText("Automations aren't running: the scheduler is stopped."),
    ).toBeTruthy();
    unmount();
    schedulerHooks.status = {
      ...healthy,
      data: {
        providers: {
          'built-in': {
            running: true,
            healthy: false,
            lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
        },
      },
    };
    const stale = render(<ScheduleView />);
    expect(screen.getByText(/Automations aren't running on time/)).toBeTruthy();
    stale.unmount();
    schedulerHooks.status = { ...healthy };
    render(<ScheduleView />);
    expect(screen.queryByText(/Automations aren't running/)).toBeNull();
    expect(screen.queryByText(/Healthy/)).toBeNull();
  });

  test('a failed status read keeps the list and offers a retry', () => {
    schedulerHooks.jobs.data = [job({ displayName: 'Daily briefing' })];
    schedulerHooks.status = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('nope'),
    };
    render(<ScheduleView />);
    expect(
      screen.getByText(
        "Station couldn't check whether automations are running",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Daily briefing' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryQueries.status).toHaveBeenCalled();
  });
});

describe('Next 7 days', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    schedulerHooks.weeks = {};
    weekReads.mockReset();
    schedulerHooks.status = {
      data: { providers: { 'built-in': { running: true, healthy: true } } },
      isLoading: false,
      isError: false,
      error: null,
    };
  });
  afterEach(() => vi.useRealTimers());

  function seed(
    jobs: Array<Record<string, unknown>>,
    weeks: Record<string, Array<Record<string, unknown>>>,
  ) {
    schedulerHooks.jobs = {
      data: jobs,
      isLoading: false,
      isError: false,
      error: null,
    };
    for (const [start, data] of Object.entries(weeks))
      schedulerHooks.weeks[start] = { data, isLoading: false, isError: false };
  }

  test('reads this week and next, starts today, names automations by display name, and bounds each day', () => {
    // Saturday 21 November 2026, noon UTC.
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    const base = { provider: 'built-in', enabled: true, prompt: 'x' };
    const digest = {
      ...base,
      name: 'digest',
      displayName: 'Daily repo digest',
    };
    const busy = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      name: `busy-${index}`,
      displayName: `Busy ${index}`,
    }));
    seed([digest, ...busy], {
      '2026-11-16': [
        {
          ...digest,
          weekOccurrences: {
            // Earlier today is over; later today is ahead.
            times: ['2026-11-21T08:00:00.000Z', '2026-11-21T16:00:00.000Z'],
            truncated: false,
          },
        },
        ...busy.map((job) => ({
          ...job,
          weekOccurrences: { times: [], truncated: false },
        })),
      ],
      '2026-11-23': [
        {
          ...digest,
          weekOccurrences: {
            // Saturday 28 is the eighth day: outside the window.
            times: ['2026-11-23T08:00:00.000Z', '2026-11-28T08:00:00.000Z'],
            truncated: false,
          },
        },
        ...busy.map((job, index) => ({
          ...job,
          weekOccurrences: {
            times: [`2026-11-24T1${index}:00:00.000Z`],
            truncated: false,
          },
        })),
      ],
    });
    render(<ScheduleView />);
    expect(weekReads.mock.calls.map(([start]) => start)).toContain(
      '2026-11-23',
    );
    expect(weekReads.mock.calls.map(([start]) => start)).toContain(
      '2026-11-16',
    );
    const week = screen.getByRole('list', { name: 'Next 7 days' });
    const days = within(week).getAllByRole('listitem', {
      name: /2026|November/,
    });
    expect(days).toHaveLength(7);
    const today = days[0]!;
    expect(today.getAttribute('aria-label')).toMatch(/^Today/);
    expect(within(today).getAllByText('Daily repo digest')).toHaveLength(1);
    expect(within(today).getByRole('time').getAttribute('datetime')).toBe(
      '2026-11-21T16:00:00.000Z',
    );
    expect(within(days[1]!).getByText('Nothing scheduled')).toBeTruthy();
    // Five runs on Tuesday: three shown, then "2 more".
    const tuesday = days[3]!;
    expect(within(tuesday).getAllByText(/^Busy /)).toHaveLength(3);
    expect(within(tuesday).getByText('2 more')).toBeTruthy();
    expect(
      within(week)
        .getAllByRole('time')
        .some(
          (time) =>
            time.getAttribute('datetime') === '2026-11-28T08:00:00.000Z',
        ),
    ).toBe(false);
    // On a phone: the next three, and how many more.
    const nextUp = screen.getByRole('list', { name: 'Next up' });
    expect(
      within(nextUp).getAllByText(/^(Daily repo digest|Busy \d)$/),
    ).toHaveLength(3);
    expect(within(nextUp).getByText('4 more in the next 7 days')).toBeTruthy();
    expect(screen.queryByText('digest', { exact: true })).toBeNull();
  });

  test('a forecast the server did not give is unknown, not an empty week', () => {
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    const job = {
      name: 'older',
      provider: 'built-in',
      enabled: true,
      prompt: 'x',
    };
    seed([job], { '2026-11-16': [job], '2026-11-23': [job] });
    render(<ScheduleView />);
    expect(screen.getByText("The next 7 days can't be shown")).toBeTruthy();
    expect(screen.queryByText('Nothing scheduled')).toBeNull();
    expect(screen.getByRole('button', { name: 'older' })).toBeTruthy();
  });
});
