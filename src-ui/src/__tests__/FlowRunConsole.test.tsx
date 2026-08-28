/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

const runsState: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
} = { data: undefined, isLoading: false, error: null };

const consoleState: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
} = { data: undefined, isLoading: false, error: null };

const consoleQueryArgs: Array<[unknown, unknown]> = [];
const taskState = {
  data: [] as Array<{ id: string; title: string; status: string }>,
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
};
const attachMutation = {
  isPending: false,
  mutateAsync: vi.fn().mockResolvedValue({}),
};
const evaluationState = {
  data: undefined as unknown,
  isLoading: false,
  error: null as Error | null,
};
let requestScopeState: { apiBase: string; authorityKey: string } | undefined = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-a',
};

let selectedProject: string | null = 'dev';

vi.mock('@kontourai/station-sdk', () => ({
  useFlowRunsQuery: () => runsState,
  useFlowRunConsoleQuery: (projectSlug: unknown, runId: unknown) => {
    consoleQueryArgs.push([projectSlug, runId]);
    return consoleState;
  },
  useTasksQuery: () => taskState,
  isApiRequestScope: (value: unknown) =>
    Boolean(
      value &&
        typeof value === 'object' &&
        'apiBase' in value &&
        'authorityKey' in value,
    ),
}));

vi.mock('@kontourai/station-sdk/flow-gate-evaluations', () => ({
  useAttachTaskFlowGateEvaluationMutation: () => attachMutation,
  useProjectFlowGateEvaluationQuery: () => evaluationState,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => requestScopeState,
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedProject }),
}));

import { FlowRunConsole } from '../components/flow/FlowRunConsole';

const RUNS = [
  {
    run_id: 'dogfood-005-trust-surfaces',
    definition_id: 'station-delivery',
    subject: 'trust surfaces',
    status: 'active',
    current_step: 'implement',
    updated_at: '2026-06-12T02:00:00.000Z',
  },
  {
    run_id: 'dogfood-004-survey-workbench-plugin',
    definition_id: 'station-delivery',
    subject: 'survey plugin',
    status: 'completed',
    current_step: 'readiness',
    updated_at: '2026-06-11T02:00:00.000Z',
  },
];

const CONSOLE_PROJECTION = {
  run: {
    run_id: 'dogfood-005-trust-surfaces',
    definition_id: 'station-delivery',
    definition_version: '1',
    subject: 'trust surfaces',
    status: 'active',
    current_step: 'implement',
    updated_at: '2026-06-12T02:00:00.000Z',
  },
  steps: [],
  current_step: 'implement',
  open_gates: ['implement-gate'],
  gates: [
    {
      id: 'implement-gate',
      step_id: 'implement',
      status: 'route-back',
      summary: 'evidence failed static checks',
      is_open: true,
      expectations: [
        {
          id: 'static-gates-green',
          kind: 'trust.bundle',
          required: true,
          description: 'verify:static passes',
        },
      ],
      evidence: [
        {
          id: 'ev-1',
          gate_id: 'implement-gate',
          kind: 'trust.bundle',
          status: 'failed',
          expectation_ids: ['static-gates-green'],
          producer: 'station/verify-static',
          stored_path: null,
          route_reason: 'implementation_defect',
          raw: {
            bundle: {
              claims: [
                { claimType: 'quality.static-checks', status: 'failed' },
              ],
            },
          },
        },
      ],
      missing: ['static-gates-green'],
      route_back_to: 'implement',
      route_reason: 'implementation_defect',
      attempt: 1,
      max_attempts: 3,
      limit_exceeded: false,
      evaluation_ref: {
        runId: 'dogfood-005-trust-surfaces',
        gateId: 'implement-gate',
        evaluationId: '018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
      },
    },
  ],
  evidence: [
    {
      id: 'ev-1',
      gate_id: 'implement-gate',
      kind: 'trust.bundle',
      status: 'failed',
      expectation_ids: ['static-gates-green'],
      producer: 'station/verify-static',
      stored_path: null,
      route_reason: 'implementation_defect',
      raw: {
        bundle: {
          claims: [{ claimType: 'quality.static-checks', status: 'failed' }],
        },
      },
    },
    {
      id: 'ev-2',
      gate_id: 'implement-gate',
      kind: 'trust.bundle',
      status: 'trusted',
      expectation_ids: ['multi-claim-bundle'],
      producer: 'station/verify-static',
      stored_path: null,
      route_reason: null,
      raw: {
        bundle: {
          claims: [
            { claimType: 'quality.static-checks', status: 'trusted' },
            { claimType: 'quality.unit-tests', status: 'trusted' },
          ],
        },
      },
    },
    {
      id: 'ev-3',
      gate_id: 'implement-gate',
      kind: 'trust.bundle',
      status: 'recorded',
      expectation_ids: [],
      producer: 'station/verify-static',
      stored_path: null,
      route_reason: null,
      raw: {},
    },
  ],
  exceptions: [
    {
      id: 'ex-1',
      gate_id: 'implement-gate',
      reason: 'flaky infra',
      authority: 'lead',
      accepted_at: '2026-06-12T02:30:00.000Z',
    },
  ],
  route_backs: [
    {
      id: 'rb-1',
      gate_id: 'implement-gate',
      route_back_to: 'implement',
      reason: 'implementation_defect',
      recovery_step: null,
      attempt: 1,
      max_attempts: 3,
      limit_exceeded: false,
    },
  ],
  next_action: 'fix the static checks and re-attach evidence',
  report: {
    path: '/ws/.kontourai/flow/runs/dogfood-005-trust-surfaces/report.json',
  },
};

beforeEach(() => {
  runsState.data = undefined;
  runsState.isLoading = false;
  runsState.error = null;
  consoleState.data = undefined;
  consoleState.isLoading = false;
  consoleState.error = null;
  consoleQueryArgs.length = 0;
  taskState.data = [];
  taskState.isLoading = false;
  taskState.error = null;
  taskState.refetch.mockReset();
  attachMutation.isPending = false;
  attachMutation.mutateAsync.mockReset().mockResolvedValue({});
  evaluationState.data = undefined;
  evaluationState.isLoading = false;
  evaluationState.error = null;
  requestScopeState = {
    apiBase: 'http://station.test',
    authorityKey: 'authority-a',
  };
  selectedProject = 'dev';
  clipboardAbsent();
});

describe('FlowRunConsole', () => {
  test('renders the run list and the most recent run detail', () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    render(<FlowRunConsole />);

    // Retired definition and run identifiers remain routing identities only;
    // neither the list nor detail surface may disclose them.
    expect(
      screen.getAllByText('Legacy delivery checks').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('station-delivery')).toBeNull();
    expect(screen.queryByText('dogfood-005-trust-surfaces')).toBeNull();
    expect(
      screen.queryByText('dogfood-004-survey-workbench-plugin'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('station-delivery');
    expect(document.body.textContent).not.toContain(
      'dogfood-005-trust-surfaces',
    );
    expect(document.body.textContent).not.toContain(
      'dogfood-004-survey-workbench-plugin',
    );
    expect(screen.getByText('step: implement')).toBeTruthy();

    // Detail: gate with outcome, open expectations, route-back state.
    expect(
      screen.getByRole('region', { name: 'Gate implement-gate' }),
    ).toBeTruthy();
    expect(screen.getByText('implement-gate · route-back')).toBeTruthy();
    expect(screen.getAllByText('static-gates-green').length).toBeGreaterThan(0);
    expect(screen.getAllByText('attempt 1 of 3').length).toBeGreaterThan(0);

    // Exceptions + evidence manifest summary (status counts render through
    // the Console Kit Metric primitive: label span + value strong).
    expect(screen.getByText(/flaky infra/)).toBeTruthy();
    expect(screen.getByText('Evidence (3)')).toBeTruthy();
    const metrics = Array.from(
      document.querySelectorAll('.flow-run-console__metric'),
    ).map((metric) => ({
      label: metric.querySelector('span')?.textContent,
      value: metric.querySelector('strong')?.textContent,
    }));
    expect(metrics).toEqual(
      expect.arrayContaining([
        { label: 'failed', value: '1' },
        { label: 'trusted', value: '1' },
        { label: 'recorded', value: '1' },
      ]),
    );

    // Evidence claim labels: the gate card's evidence row (single-claim
    // trust.bundle) reads the claim type from `entry.raw.bundle.claims`,
    // not the retired top-level `claim` field.
    expect(
      document.querySelectorAll('.flow-run-console__evidence-claim')[0]
        ?.textContent,
    ).toBe('quality.static-checks');
    // Evidence list: single-claim entry appears again (ev-1 is both a gate
    // outcome and a manifest entry), a multi-claim bundle joins with ' · ',
    // and an entry with no bundle claims falls back to its kind.
    expect(screen.getAllByText('quality.static-checks').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByText('quality.static-checks · quality.unit-tests'),
    ).toBeTruthy();
    expect(screen.getAllByText('trust.bundle').length).toBeGreaterThan(0);

    // The persisted legacy report path also embeds the retired run identity,
    // so it is not a presentation or clipboard surface.
    expect(screen.queryByRole('region', { name: 'Report' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Copy report path' }),
    ).toBeNull();
  });

  test('selecting a run loads its console projection', () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    render(<FlowRunConsole />);

    const runButtons = screen.getAllByRole('button', {
      name: /Legacy delivery checks/,
    });
    fireEvent.click(runButtons[1]);
    expect(
      consoleQueryArgs.some(
        ([, runId]) => runId === 'dogfood-004-survey-workbench-plugin',
      ),
    ).toBe(true);
  });

  test('shows the empty state when the project has no runs', () => {
    runsState.data = [];
    render(<FlowRunConsole />);
    expect(screen.getByText(/No Flow runs yet/)).toBeTruthy();
  });

  test('shows an error state when runs cannot be listed', () => {
    runsState.error = new Error('workspace unavailable');
    render(<FlowRunConsole />);
    expect(screen.getByRole('alert').textContent).toContain(
      'workspace unavailable',
    );
  });

  test('asks for a project when none is selected', () => {
    selectedProject = null;
    render(<FlowRunConsole />);
    expect(
      screen.getByText(
        'Open this console inside a project to see its Flow runs.',
      ),
    ).toBeTruthy();
  });

  // archive#612: the deterministic /projects/:slug/flow-console route passes
  // both props explicitly so a gate item's deep link works even when the
  // console is opened outside a project layout tab (no navigation context
  // selection to fall back to).
  test('preselects the run named by the initialRunId prop instead of the most recent one', () => {
    selectedProject = null;
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    render(
      <FlowRunConsole
        projectSlug="dev"
        initialRunId="dogfood-004-survey-workbench-plugin"
      />,
    );

    expect(
      consoleQueryArgs.some(
        ([projectSlug, runId]) =>
          projectSlug === 'dev' &&
          runId === 'dogfood-004-survey-workbench-plugin',
      ),
    ).toBe(true);
  });

  test('an initialRunId that matches no run falls back to the most recent run', () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    render(<FlowRunConsole projectSlug="dev" initialRunId="missing-run" />);

    expect(
      consoleQueryArgs.some(
        ([, runId]) => runId === 'dogfood-005-trust-surfaces',
      ),
    ).toBe(true);
  });

  test('inspects and keeps only the captured public evaluation reference', async () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    taskState.data = [{ id: 'task-a', title: 'Task A', status: 'open' }];
    evaluationState.data = {
      originalVerdict: 'route-back',
      currentStanding: 'current',
      validityAsOf: '2026-06-12T02:30:00.000Z',
      externalRevocation: 'not-observed',
    };
    render(<FlowRunConsole />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect evaluation' }));
    expect(screen.getByText(/Original verdict: route-back/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: /Keep gate evaluation/ }),
    );
    expect(taskState.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Task A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() =>
      expect(attachMutation.mutateAsync).toHaveBeenCalledWith({
        taskId: 'task-a',
        ref: CONSOLE_PROJECTION.gates[0].evaluation_ref,
        sourceSurface: 'flow-console',
      }),
    );
    expect(
      screen.getByText('Gate evaluation kept in Task “Task A”.'),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: /Keep gate evaluation/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: /Keep gate evaluation/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Keep gate evaluation in Task' }),
      ).toBeNull(),
    );
  });

  test('closes a captured Task picker before a replacement authority can use it', async () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    taskState.data = [{ id: 'task-a', title: 'Task A', status: 'open' }];
    const view = render(<FlowRunConsole />);

    fireEvent.click(
      screen.getByRole('button', { name: /Keep gate evaluation/ }),
    );
    await waitFor(() => expect(taskState.refetch).toHaveBeenCalled());
    expect(
      screen.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toBeTruthy();

    requestScopeState = {
      apiBase: 'http://station.test',
      authorityKey: 'authority-b',
    };
    view.rerender(<FlowRunConsole />);

    expect(
      screen.queryByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toBeNull();
    expect(attachMutation.mutateAsync).not.toHaveBeenCalled();
  });

  test('hides an A receipt notice and ignores its late completion after authority B takes over', async () => {
    runsState.data = RUNS;
    consoleState.data = CONSOLE_PROJECTION;
    taskState.data = [{ id: 'task-a', title: 'Task A', status: 'open' }];
    let release!: () => void;
    attachMutation.mutateAsync.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const view = render(<FlowRunConsole />);
    fireEvent.click(
      screen.getByRole('button', { name: /Keep gate evaluation/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Task A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Task' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));

    requestScopeState = {
      apiBase: 'http://station.test',
      authorityKey: 'authority-b',
    };
    view.rerender(<FlowRunConsole />);
    release();
    await waitFor(() =>
      expect(
        screen.queryByText('Gate evaluation kept in Task “Task A”.'),
      ).toBeNull(),
    );
  });
});

// archive#3341: the report path was copied through a module-level helper whose
// `.catch( => {})` swallowed the refusal and — behind `navigator.clipboard?.`
// — could not even run on an origin with no clipboard. Nothing on screen ever
// said whether the copy happened.
describe('FlowRunConsole report path copy (station#3341)', () => {
  const LIVE_PROJECTION = {
    ...CONSOLE_PROJECTION,
    run: { ...CONSOLE_PROJECTION.run, definition_id: 'builder.build' },
  };
  const LIVE_RUNS = [
    { ...RUNS[0], definition_id: 'builder.build' },
    ...RUNS.slice(1),
  ];

  function copyButton() {
    return screen.getByRole('button', { name: 'Copy report path' });
  }

  function renderConsole() {
    runsState.data = LIVE_RUNS;
    consoleState.data = LIVE_PROJECTION;
    return render(<FlowRunConsole />);
  }

  test('reports the copy only once the write resolved', async () => {
    const writeText = clipboardWrites();
    renderConsole();

    fireEvent.click(copyButton());

    expect(writeText).toHaveBeenCalledWith(LIVE_PROJECTION.report.path);
    await waitFor(() => expect(copyButton().textContent).toBe('Copied'));
    expect(screen.getByRole('status').textContent).toBe('Report path copied.');
  });

  test('a refused write says so instead of failing silently', async () => {
    clipboardRefuses();
    renderConsole();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(copyButton().textContent).not.toContain('Copied');
    expect(screen.getByRole('status').textContent).toContain(
      'refused clipboard access',
    );
  });

  test('an insecure origin with no clipboard API says so instead of failing silently', async () => {
    clipboardAbsent();
    renderConsole();

    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(screen.getByRole('status').textContent).toContain(
      'refused clipboard access',
    );
  });
});
