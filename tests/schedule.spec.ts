import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import {
  type SchedulerSchedule,
  schedulerJobSlugCandidates,
} from '@kontourai/station-contracts/scheduler';
import type { ModelConnectionConfig } from '@kontourai/station-contracts/tool';
import { expect, type Page } from '@playwright/test';
import { modelConnectionFixture } from './helpers/connection-fixtures';
import { test } from './helpers/fixture-audit';

type ScheduleJobRecord = {
  name: string;
  displayName?: string;
  provider: string;
  cron: string;
  // The server serves the discriminated object, not the legacy string:
  // `scheduleForJob` short-circuits on a truthy `schedule`
  // (`components/scheduler/scheduleValue.ts:32-35`), so a string left
  // `form.scheduleKind` undefined and NONE of the three schedule-kind
  // branches rendered — no cron editor, no `CronPreview`, and an
  // `Once at Invalid Date` cell in the jobs table.
  schedule: SchedulerSchedule;
  prompt: string;
  agent: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  retryCount?: number;
  retryDelaySecs?: number;
};

function makeJob(
  overrides: Partial<ScheduleJobRecord> & Pick<ScheduleJobRecord, 'name'>,
): ScheduleJobRecord {
  const cron = overrides.cron ?? '0 9 * * *';
  return {
    provider: 'built-in',
    cron,
    schedule: { kind: 'cron', expr: cron } as const,
    prompt: 'Generate the daily report',
    agent: 'station',
    enabled: true,
    lastRun: '2026-04-25T15:00:00.000Z',
    nextRun: '2026-04-26T15:00:00.000Z',
    retryCount: 0,
    retryDelaySecs: 60,
    ...overrides,
  };
}

async function seedScheduleCrudApi(page: Page) {
  const jobs = new Map<string, ScheduleJobRecord>([
    [
      'daily-report',
      makeJob({
        name: 'daily-report',
        prompt: 'Generate the daily report',
        agent: 'codex',
      }),
    ],
  ]);
  const runCalls: string[] = [];
  /** Every create body the form sent, in order. */
  const createBodies: Array<Record<string, unknown>> = [];

  // The handshake is this Station's own, and it must advertise that the
  // host picks a display name's slug: the duplicate step below proves that
  // path, which the form takes only on this flag.
  await page.route('**/.well-known/station/v1', async (route) => {
    const response = await route.fetch();
    const handshake = await response.json();
    if (handshake.capabilities?.schedulerJobDisplayName !== true)
      throw new Error(
        'this Station does not advertise schedulerJobDisplayName',
      );
    await route.fulfill({ response, json: handshake });
  });

  // archive#947: this suite mocks every scheduler endpoint but left `/api/system/status`
  // to the live instance, so whether the first-run setup launcher rendered was
  // decided by whatever the server happened to have configured. On a clean
  // `--temp-home` instance `providers.configuredChatReady` is false, the
  // launcher's backdrop covers the page, and every click here dies on
  // "onboarding-setup-launcher__backdrop intercepts pointer events". Inside the
  // product bucket the same spec passed only because an earlier spec had already
  // made the shared instance chat-ready — an ordering dependency, not a pass.
  // `setupBannerVariant` (src-ui/src/components/onboardingGateUtils.ts) hides the
  // launcher on `configuredChatReady`, so pin it here the way the other 41 specs
  // pin their status. Nothing about the schedule assertions changes.
  await page.route('**/api/system/status', (route) =>
    route.fulfill({
      json: {
        ready: true,
        acp: { connected: false, connections: [] },
        clis: {},
        prerequisites: [],
        providers: {
          configuredChatReady: true,
          configured: [],
          detected: { ollama: false, bedrock: false },
        },
      },
    }),
  );
  await page.route('**/api/agents', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          { id: 'station', slug: 'station', name: 'Station', available: true },
          { id: 'codex', slug: 'codex', name: 'Codex', available: true },
        ],
      },
    }),
  );
  await page.route('**/scheduler/providers', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: [
          {
            id: 'built-in',
            displayName: 'Built-in Scheduler',
            capabilities: ['prompt'],
          },
        ],
      },
    }),
  );
  await page.route('**/scheduler/status', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          providers: {
            'built-in': {
              id: 'built-in',
              displayName: 'Built-in Scheduler',
              running: true,
              healthy: true,
              lastTickAt: '2026-04-25T15:01:00.000Z',
            },
          },
        },
      },
    }),
  );
  await page.route('**/scheduler/stats', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          providers: {
            'built-in': {
              jobs: Array.from(jobs.values()).map((job) => ({
                name: job.name,
                total: 1,
                successes: job.enabled ? 1 : 0,
                failures: job.enabled ? 0 : 1,
                success_rate: job.enabled ? 100 : 0,
              })),
            },
          },
          summary: {
            totalJobs: jobs.size,
            totalRuns: jobs.size,
            successRate: jobs.size ? 100 : -1,
          },
        },
      },
    }),
  );
  await page.route('**/scheduler/jobs/preview-schedule**', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: ['2026-04-26T15:00:00.000Z'],
      },
    }),
  );
  await page.route('**/scheduler/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      createBodies.push(body);
      // As the scheduler does: an explicit slug that is taken is refused; a
      // create that names only a display name gets the first unused slug.
      const name: string | undefined = body.name
        ? jobs.has(body.name)
          ? undefined
          : body.name
        : schedulerJobSlugCandidates(body.displayName).find(
            (candidate) => !jobs.has(candidate),
          );
      if (!name) {
        await route.fulfill({
          status: 409,
          json: {
            success: false,
            code: 'job_name_taken',
            error: body.name
              ? `Job '${body.name}' already exists`
              : `Too many automations already have names like '${body.displayName}'. Choose a different name.`,
          },
        });
        return;
      }
      const job = makeJob({
        name,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        provider: body.provider ?? 'built-in',
        cron: body.cron ?? '* * * * *',
        prompt: body.prompt ?? '',
        // A job that runs in its own chat names its agent in `target`, as
        // the server stores it; a made-up agent left the duplicate's Create
        // disabled whenever the host answered the chat capability first.
        agent: body.agent ?? body.target?.agent ?? 'station',
        retryCount: body.retryCount ?? 0,
        retryDelaySecs: body.retryDelaySecs ?? 60,
      });
      jobs.set(job.name, job);
      await route.fulfill({
        json: {
          success: true,
          data: { output: `Job '${job.name}' created`, name: job.name },
        },
      });
      return;
    }
    await route.fulfill({
      json: { success: true, data: Array.from(jobs.values()) },
    });
  });
  await page.route('**/scheduler/jobs/**', async (route) => {
    const request = route.request();
    const pathParts = new URL(request.url()).pathname.split('/');
    const target = decodeURIComponent(pathParts[3] ?? '');
    const action = pathParts[4];

    if (target === 'preview-schedule') {
      await route.fallback();
      return;
    }

    const current = jobs.get(target);

    if (action === 'run' && request.method() === 'POST') {
      runCalls.push(target);
      await route.fulfill({ json: { success: true, data: current } });
      return;
    }
    if (
      (action === 'enable' || action === 'disable') &&
      request.method() === 'PUT'
    ) {
      if (current) {
        jobs.set(target, { ...current, enabled: action === 'enable' });
      }
      await route.fulfill({ json: { success: true, data: jobs.get(target) } });
      return;
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      if (current) {
        const cron = body.cron ?? current.cron;
        jobs.set(target, {
          ...current,
          ...body,
          cron,
          schedule: { kind: 'cron', expr: cron } as const,
        });
      }
      await route.fulfill({ json: { success: true, data: jobs.get(target) } });
      return;
    }
    if (request.method() === 'DELETE') {
      jobs.delete(target);
      await route.fulfill({ json: { success: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { success: false } });
  });
  await page.route('**/api/runs', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );

  return { runCalls, createBodies };
}

async function fillCron(
  page: Page,
  cron: [string, string, string, string, string],
) {
  await page
    .getByRole('group', { name: 'Schedule type', exact: true })
    .getByRole('button', { name: 'Cron', exact: true })
    .click();
  const labels = ['minute', 'hour', 'day', 'month', 'weekday'];
  for (const [index, value] of cron.entries()) {
    await page.getByLabel(labels[index], { exact: true }).fill(value);
  }
}

test.describe('Schedule Page', () => {
  test('lists active automations, then paused ones, each by the name people read, with what happens next', async ({
    page,
  }) => {
    await seedScheduleCrudApi(page);
    const listed = [
      makeJob({
        name: 'aa-paused',
        displayName: 'Alpha report',
        enabled: false,
        nextRun: undefined,
      }),
      makeJob({ name: 'b-active', displayName: 'Zulu report' }),
      makeJob({
        name: 'z-active',
        displayName: 'Mike report',
        nextRun: '2026-04-27T15:00:00.000Z',
      }),
    ];
    // Registered after the seed, so it answers the list read first.
    await page.route('**/scheduler/jobs', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { success: true, data: listed } })
        : route.fallback(),
    );
    await page.goto('/automations');

    const list = page.getByRole('list', { name: 'All automations' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await expect(list.locator('.automations-row__name')).toHaveText([
      'Mike report',
      'Zulu report',
      'Alpha report',
    ]);
    // The slug is never what a row says.
    await expect(list).not.toContainText('z-active');
    const mike = page.getByTestId('job-row-z-active');
    await expect(mike.locator('.automations-row__status')).toHaveText('Active');
    await expect(mike).toContainText(/Every day at 9:00 AM/);
    await expect(mike).toContainText(/Next: /);
    const alpha = page.getByTestId('job-row-aa-paused');
    await expect(alpha.locator('.automations-row__status')).toHaveText(
      'Paused',
    );
    await expect(alpha).toContainText("Won't run while paused");
    // No column headers or tabs: the rows say it all.
    await expect(page.getByRole('columnheader')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
  });

  test('an empty agent catalog leads from scheduled jobs to the model-connection agent choice', async ({
    page,
  }) => {
    await seedScheduleCrudApi(page);
    await page.route('**/api/agents', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    );
    await page.goto('/automations');
    await page
      .getByRole('button', { name: 'New automation', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    // This Station advertises chat automations, so the form settles on "Its
    // own chat" once the handshake answers; asserting before that raced the
    // Station-engine wording against it.
    await expect(dialog.getByLabel('Run in')).toHaveValue('dedicated');
    await expect(
      dialog.getByText(
        'Scheduled jobs need an agent that is set up and ready.',
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create automation', exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel('Name').fill('keep-my-check');
    await dialog
      .getByLabel('Instructions')
      .fill('Check my service each morning');
    await dialog
      .getByRole('button', { name: 'Set up a scheduled-job agent' })
      .click();
    await expect(page).toHaveURL(/\/agents\/new$/);
    await expect(
      page.getByRole('button', { name: /Use a model connection/ }),
    ).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue('keep-my-check');
    await expect(dialog.getByLabel('Instructions')).toHaveValue(
      'Check my service each morning',
    );
    await expect(
      dialog.getByRole('button', { name: 'Create automation', exact: true }),
    ).toBeDisabled();
  });

  test('a phone-sized job repairs its existing agent and resumes the exact draft automatically', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedScheduleCrudApi(page);
    let repaired = false;
    let publishHealth!: () => void;
    const healthPublished = new Promise<void>((resolve) => {
      publishHealth = resolve;
    });
    // The fixture supplies the runtime health event emitted after a save;
    // the real shell owns invalidation, readiness checking and route return.
    await page.route('**/events', async (route) => {
      await healthPublished;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: 'event: runtime:health-changed\ndata: {}\n\n',
      });
    });
    let model = modelConnectionFixture({
      id: 'existing-model',
      name: 'My local model',
      config: { baseUrl: 'http://127.0.0.1:11434' },
    });
    await page.route('**/api/connections/models', (route) =>
      route.fulfill({ json: { success: true, data: [model] } }),
    );
    await page.route('**/api/connections/existing-model', async (route) => {
      if (route.request().method() === 'PUT') {
        model = route.request().postDataJSON() as ModelConnectionConfig;
        repaired = true;
        await route.fulfill({ json: { success: true, data: model } });
        publishHealth();
      } else await route.fulfill({ json: { success: true, data: model } });
    });
    const agent: EnrichedAgentProjection = {
      slug: agentId('station'),
      name: 'Station',
      available: false,
      unavailableReason: 'Connect a model before running this agent.',
      unavailableFix: { kind: 'model-connection' },
    };
    await page.route('**/api/agents', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              ...agent,
              available: repaired,
              unavailableReason: repaired ? undefined : agent.unavailableReason,
            },
          ],
        },
      }),
    );
    await page.goto('/automations');
    await page
      .getByRole('button', { name: 'New automation', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });
    for (const label of ['Name', 'Instructions']) {
      const fontSize = await dialog
        .getByLabel(label)
        .evaluate((field) =>
          Number.parseFloat(getComputedStyle(field).fontSize),
        );
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    await dialog.getByLabel('Name').fill('recovered-check');
    await dialog
      .getByLabel('Instructions')
      .fill('Check the service without duplicating my agent');
    await dialog.getByRole('button', { name: 'Exact interval' }).click();
    await dialog.getByLabel('Interval value').fill('17');
    await dialog.getByLabel('Interval unit').selectOption('minutes');
    await dialog
      .getByRole('button', { name: 'Repair this agent’s setup' })
      .click();
    await expect(page).toHaveURL(/\/customize\/providers$/);
    await expect(dialog).not.toBeVisible();
    await page
      .getByRole('button', { name: 'My local model', exact: true })
      .click();
    await expect(page).toHaveURL(/\/customize\/providers\/existing-model$/);
    await page
      .getByRole('textbox', { name: 'Base URL', exact: true })
      .fill('http://127.0.0.1:11435');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/\/automations$/);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue('recovered-check');
    await expect(dialog.getByLabel('Instructions')).toHaveValue(
      'Check the service without duplicating my agent',
    );
    await expect(dialog.getByLabel('Interval value')).toHaveValue('17');
    await expect(dialog.getByLabel('Interval unit')).toHaveValue('minutes');
    expect(model.id).toBe('existing-model');
    expect(model.config.baseUrl).toBe('http://127.0.0.1:11435');
    await dialog
      .getByRole('button', { name: 'Create automation', exact: true })
      .click();
    await expect(page.getByTestId('job-row-recovered-check')).toBeVisible();
  });

  test('covers add, edit, duplicate, run, pause, resume and delete from the row menu', async ({
    page,
  }) => {
    const { runCalls, createBodies } = await seedScheduleCrudApi(page);
    await page.goto('/automations');

    await expect(
      page.getByRole('heading', { name: 'Automations', exact: true, level: 1 }),
    ).toBeVisible();
    const daily = page.getByTestId('job-row-daily-report');
    await expect(daily).toBeVisible();
    await expect(daily.locator('.automations-row__status')).toHaveText(
      'Active',
    );
    // One automation: no filter until there are more than 15.
    await expect(page.getByPlaceholder('Filter automations…')).toHaveCount(0);

    const menu = async (label: string, item: string) => {
      await page.getByRole('button', { name: `Actions for ${label}` }).click();
      await page.getByRole('menuitem', { name: item, exact: true }).click();
    };

    await menu('daily-report', 'Duplicate');
    const duplicateDialog = page.getByRole('dialog', {
      name: 'New automation',
    });
    await expect(
      duplicateDialog.locator('.agent-picker__trigger'),
    ).toContainText('Codex');
    await expect(duplicateDialog.getByLabel('Name')).toHaveValue(
      'daily-report copy',
    );
    // The same name as the job it copies: the copy gets its own hidden slug
    // instead of a refusal the person cannot get past.
    await duplicateDialog.getByLabel('Name').fill('daily-report');
    await duplicateDialog
      .getByRole('button', { name: 'Create automation', exact: true })
      .click();
    await expect(duplicateDialog).toBeHidden();
    await expect(page.getByTestId('job-row-daily-report-2')).toContainText(
      'daily-report',
    );
    // The host picked that slug: the form sent only the name people read.
    expect(createBodies.at(-1)).toMatchObject({ displayName: 'daily-report' });
    expect(createBodies.at(-1)).not.toHaveProperty('name');
    await expect(daily).toBeVisible();

    await page
      .getByRole('button', { name: 'New automation', exact: true })
      .click();
    // Plain words; the hidden slug `weekly-brief` is what routes and runs use.
    await page.getByPlaceholder('Daily briefing').fill('Weekly brief');
    await page
      .getByPlaceholder('What should the agent do?')
      .fill('Summarize weekly work');
    await fillCron(page, ['30', '8', '*', '*', '1']);
    await page
      .getByRole('button', { name: 'Create automation', exact: true })
      .click();
    const weekly = page.getByTestId('job-row-weekly-brief');
    await expect(weekly).toBeVisible();

    await menu('Weekly brief', 'Edit');
    await page
      .getByPlaceholder('What should the agent do?')
      .fill('Summarize weekly work and risks');
    await expect(
      page
        .getByRole('dialog', { name: 'Edit: Weekly brief' })
        .locator('.schedule__cron-time'),
    ).not.toHaveText('...');
    // archive#947: an Enter-submit landing during the cron editor's debounce
    // re-render was dropped about 2 runs in 20, so the keystroke is retried;
    // the dialog must still close, and a repeat Enter after a save is a no-op.
    const editDialog = page.getByRole('dialog', {
      name: 'Edit: Weekly brief',
    });
    const saveChanges = page.getByRole('button', { name: 'Save Changes' });
    await expect(async () => {
      await saveChanges.press('Enter');
      await expect(editDialog).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(editDialog).toBeHidden();
    await weekly
      .getByRole('button', { name: 'Weekly brief', exact: true })
      .click();
    await expect(
      weekly.getByText('Summarize weekly work and risks'),
    ).toBeVisible();

    await menu('Weekly brief', 'Run now');
    await expect.poll(() => runCalls).toEqual(['weekly-brief']);

    await menu('Weekly brief', 'Pause');
    await expect(weekly.locator('.automations-row__status')).toHaveText(
      'Paused',
    );
    await expect(weekly).toContainText("Won't run while paused");
    await menu('Weekly brief', 'Resume');
    await expect(weekly.locator('.automations-row__status')).toHaveText(
      'Active',
    );

    await menu('Weekly brief', 'Duplicate');
    await expect(page.getByPlaceholder('Daily briefing')).toHaveValue(
      'Weekly brief copy',
    );
    await page
      .getByRole('button', { name: 'Create automation', exact: true })
      .click();
    await expect(page.getByTestId('job-row-weekly-brief-copy')).toBeVisible();

    await menu('Weekly brief copy', 'Delete');
    await expect(page.getByRole('alertdialog')).toContainText(
      "Delete 'Weekly brief copy'?",
    );
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByTestId('job-row-weekly-brief-copy')).toHaveCount(0);
  });
});
