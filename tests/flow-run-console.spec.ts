import { expect, test } from '@playwright/test';
import {
  dismissSetupLauncher,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

// The Flow run console is a builtin layout component
// ({ kind: 'builtin-component', name: 'flow-run-console' }) — this spec
// proves a project layout tab referencing it renders the project's runs.

const FLOW_CONSOLE_LAYOUT = {
  id: 'l2',
  slug: 'flow-console',
  projectSlug: 'dev',
  type: 'custom',
  name: 'Flow Runs',
  icon: '🚦',
  config: {
    tabs: [
      {
        id: 'console',
        label: 'Run console',
        component: { kind: 'builtin-component', name: 'flow-run-console' },
      },
    ],
    globalSkills: [],
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// `station-delivery` is the RETIRED definition id: every presentation of it
// is redacted to "Legacy delivery checks" and its report path suppressed
// (`packages/contracts/src/flow-presentation.ts:1-17`,
// `components/flow/FlowRunConsole.tsx:87-89, 231-233`), so a fixture using it
// could never show a run id or a report. That redaction is owned a layer down
// by `src-ui/src/__tests__/FlowRunConsole.test.tsx:211-224, 270-278`; this
// spec is about a live definition rendering in a project layout tab.
const RUNS = [
  {
    run_id: 'dogfood-005-trust-surfaces',
    definition_id: 'delivery-v2',
    subject: 'trust surfaces',
    status: 'active',
    current_step: 'implement',
    updated_at: '2026-06-12T02:00:00.000Z',
  },
  {
    run_id: 'dogfood-004-survey-workbench-plugin',
    definition_id: 'delivery-v2',
    subject: 'survey plugin',
    status: 'completed',
    current_step: 'readiness',
    updated_at: '2026-06-11T02:00:00.000Z',
  },
];

const GATE_EVALUATION_REF = {
  runId: 'dogfood-005-trust-surfaces',
  gateId: 'implement-gate',
  evaluationId: '018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
};

const GATE_EVALUATION = {
  ref: GATE_EVALUATION_REF,
  evaluatedAt: '2026-06-12T02:00:00.000Z',
  originalVerdict: 'wait',
  kind: 'initial',
  trigger: 'ordinary',
  currentStanding: 'current',
  currentRun: { status: 'active', currentStep: 'implement' },
  selectedEvidence: [],
  validityAsOf: '2026-06-12T02:00:00.000Z',
  validityScope: 'retained-immutable-bundle',
  externalRevocation: 'not-observed',
};

const ACTIVE_CONSOLE = {
  run: {
    run_id: 'dogfood-005-trust-surfaces',
    definition_id: 'delivery-v2',
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
      status: 'wait',
      summary: 'missing required evidence',
      is_open: true,
      expectations: [
        {
          id: 'static-gates-green',
          kind: 'surface.claim',
          required: true,
          description: 'verify:static passes',
        },
      ],
      evidence: [],
      missing: ['static-gates-green'],
      evaluation_ref: GATE_EVALUATION_REF,
    },
  ],
  evidence: [],
  exceptions: [],
  route_backs: [],
  next_action: 'attach evidence for implement-gate',
  report: null,
};

const COMPLETED_CONSOLE = {
  run: {
    run_id: 'dogfood-004-survey-workbench-plugin',
    definition_id: 'delivery-v2',
    definition_version: '1',
    subject: 'survey plugin',
    status: 'completed',
    current_step: null,
    updated_at: '2026-06-11T02:00:00.000Z',
  },
  steps: [],
  current_step: null,
  open_gates: [],
  gates: [
    {
      id: 'readiness-gate',
      step_id: 'readiness',
      status: 'pass',
      summary: 'all expectations satisfied',
      is_open: false,
      expectations: [],
      evidence: [
        {
          id: 'ev-readiness',
          gate_id: 'readiness-gate',
          kind: 'surface.claim',
          status: 'recorded',
          expectation_ids: ['merge-readiness'],
          producer: 'veritas',
          stored_path: null,
          route_reason: null,
          raw: {
            bundle: {
              claims: [
                { claimType: 'governance.merge-readiness', status: 'trusted' },
              ],
            },
          },
        },
      ],
      missing: [],
    },
  ],
  evidence: [
    {
      id: 'ev-readiness',
      gate_id: 'readiness-gate',
      kind: 'surface.claim',
      status: 'recorded',
      expectation_ids: ['merge-readiness'],
      producer: 'veritas',
      stored_path: null,
      route_reason: null,
      raw: {
        bundle: {
          claims: [
            { claimType: 'governance.merge-readiness', status: 'trusted' },
          ],
        },
      },
    },
  ],
  exceptions: [],
  route_backs: [],
  next_action: null,
  report: {
    path: '/tmp/test/.kontourai/flow/runs/dogfood-004-survey-workbench-plugin/report.json',
  },
};

test.describe('Flow run console layout', () => {
  test.beforeEach(async ({ page }) => {
    await seedOrchestrationRoutes(page);
    await page.route('**/api/projects/dev/layouts/flow-console', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: FLOW_CONSOLE_LAYOUT }),
      }),
    );
    await page.route('**/api/projects/dev/flow/runs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: RUNS }),
      }),
    );
    await page.route(
      '**/api/projects/dev/flow/runs/dogfood-005-trust-surfaces/console',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: ACTIVE_CONSOLE }),
        }),
    );
    await page.route(
      '**/api/projects/dev/flow/runs/dogfood-004-survey-workbench-plugin/console',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: COMPLETED_CONSOLE }),
        }),
    );
  });

  test('renders all project runs with gate outcomes and open expectations', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/flow-console');
    await dismissSetupLauncher(page);

    // Run list shows every run with id, definition, status, step, updated.
    const sidebar = page.getByRole('complementary', { name: 'Flow runs' });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText('dogfood-005-trust-surfaces')).toBeVisible();
    await expect(
      sidebar.getByText('dogfood-004-survey-workbench-plugin'),
    ).toBeVisible();
    await expect(sidebar.getByText('step: implement')).toBeVisible();

    // Most recent run is selected: waiting gate with open expectations.
    await expect(
      page.getByRole('region', { name: 'Gate implement-gate' }),
    ).toBeVisible();
    await expect(page.getByText('implement-gate · wait')).toBeVisible();
    await expect(page.getByText('Open expectations:')).toBeVisible();
    await expect(page.getByText('static-gates-green')).toBeVisible();
    await expect(
      page.getByText('Next: attach evidence for implement-gate'),
    ).toBeVisible();
  });

  test('selecting a run shows its evidence, verdicts, and report path', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/flow-console');
    await dismissSetupLauncher(page);

    await page
      .getByRole('button', { name: /dogfood-004-survey-workbench-plugin/ })
      .click();

    await expect(page.getByText('readiness-gate · pass')).toBeVisible();
    await expect(page.getByText('Evidence (1)')).toBeVisible();
    await expect(
      page.getByText('governance.merge-readiness').first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        '/tmp/test/.kontourai/flow/runs/dogfood-004-survey-workbench-plugin/report.json',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Copy report path' }),
    ).toBeVisible();
  });

  test('inspects and keeps an exact Flow receipt without requiring existing Tasks', async ({
    page,
  }) => {
    let taskReads = 0;
    let retained: unknown;
    await page.route(
      '**/api/projects/dev/flow/runs/dogfood-005-trust-surfaces/gates/implement-gate/evaluations/018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: GATE_EVALUATION }),
        }),
    );
    await page.route('**/api/tasks?projectId=dev', (route) => {
      taskReads += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ id: 'task-a', title: 'Task A', status: 'open' }],
        }),
      });
    });
    await page.route('**/api/tasks/task-a/references', async (route) => {
      retained = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { id: 'link-a' } }),
      });
    });

    await page.goto('/projects/dev/layouts/flow-console');
    await dismissSetupLauncher(page);
    await page.getByRole('button', { name: 'Inspect evaluation' }).click();
    await expect(page.getByText(/Original verdict: wait/)).toBeVisible();
    expect(taskReads).toBe(0);

    await page.getByRole('button', { name: /Keep gate evaluation/ }).click();
    await page.getByRole('button', { name: /Task A/ }).click();
    await page.getByRole('button', { name: 'Add to Task' }).click();
    await expect(
      page.getByText('Gate evaluation kept in Task “Task A”.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Keep gate evaluation/ }),
    ).toBeFocused();
    expect(taskReads).toBeGreaterThan(0);
    expect(retained).toEqual({
      kind: 'gate-evaluation',
      ref: GATE_EVALUATION_REF,
      sourceSurface: 'flow-console',
    });

    const keep = page.getByRole('button', {
      name: /Keep gate evaluation/,
    });
    await keep.click();
    await expect(
      page.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toHaveCount(0);
    await expect(keep).toBeFocused();

    await keep.click();
    await expect(
      page.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('dialog', { name: 'Keep gate evaluation in Task' }),
    ).toHaveCount(0);
    await expect(keep).toBeFocused();
  });

  test('shows the empty state for a project without runs', async ({ page }) => {
    await page.route('**/api/projects/dev/flow/runs', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto('/projects/dev/layouts/flow-console');
    await dismissSetupLauncher(page);

    await expect(page.getByText(/No Flow runs yet/)).toBeVisible();
  });
});
