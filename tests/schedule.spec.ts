import type { SchedulerSchedule } from '@kontourai/station-contracts/scheduler';
import { expect, type Page, test } from '@playwright/test';

type ScheduleJobRecord = {
  name: string;
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
    route.fulfill({ json: { success: true, data: [] } }),
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
      const job = makeJob({
        name: body.name,
        provider: body.provider ?? 'built-in',
        cron: body.cron ?? '* * * * *',
        prompt: body.prompt ?? '',
        agent: body.agent ?? 'default',
        retryCount: body.retryCount ?? 0,
        retryDelaySecs: body.retryDelaySecs ?? 60,
      });
      jobs.set(job.name, job);
      await route.fulfill({ json: { success: true, data: job } });
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

  return { runCalls };
}

async function fillCron(
  page: Page,
  cron: [string, string, string, string, string],
) {
  const labels = ['minute', 'hour', 'day', 'month', 'weekday'];
  for (const [index, value] of cron.entries()) {
    await page.getByLabel(labels[index], { exact: true }).fill(value);
  }
}

test.describe('Schedule Page', () => {
  test('sortable headers expose native keyboard controls and aria-sort', async ({
    page,
  }) => {
    await seedScheduleCrudApi(page);
    await page.goto('/schedule');

    const lastRun = page.getByRole('columnheader', { name: /last run/i });
    await expect(lastRun).toHaveAttribute('aria-sort', 'descending');
    await lastRun.getByRole('button').press('Enter');
    await expect(lastRun).toHaveAttribute('aria-sort', 'ascending');
    await lastRun.getByRole('button').press('Space');
    await expect(lastRun).toHaveAttribute('aria-sort', 'descending');

    // Only the sorted column carries aria-sort. Writing "none" on the others
    // makes every header announce a sort state it does not have.
    const name = page.getByRole('columnheader', { name: /^name/i });
    await expect(name.getByRole('button')).toBeVisible();
    await expect(name).not.toHaveAttribute('aria-sort', /.*/);
  });

  test('covers add, edit, duplicate, run, filter, toggle, and delete', async ({
    page,
  }) => {
    const { runCalls } = await seedScheduleCrudApi(page);
    await page.goto('/schedule');

    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    await expect(page.getByTestId('job-row-daily-report')).toBeVisible();
    await expect(
      page.getByLabel('Scheduler statistics').getByText('100%'),
    ).toBeVisible();

    await page.getByPlaceholder('Filter jobs…').fill('missing');
    await expect(
      page.getByText('Nothing in scheduled jobs matches “missing”'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Clear filter' }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('job-row-daily-report')).toBeVisible();

    await page.getByRole('button', { name: 'Add job', exact: true }).click();
    await page.getByPlaceholder('my-daily-briefing').fill('weekly-brief');
    await page
      .getByPlaceholder('What should the agent do?')
      .fill('Summarize weekly work');
    await fillCron(page, ['30', '8', '*', '*', '1']);
    await page.getByRole('button', { name: 'Add Job', exact: true }).click();
    await expect(page.getByTestId('job-row-weekly-brief')).toBeVisible();

    await page.getByRole('button', { name: 'Edit weekly-brief' }).click();
    await page
      .getByPlaceholder('What should the agent do?')
      .fill('Summarize weekly work and risks');
    await expect(
      page
        .getByRole('dialog', { name: 'Edit: weekly-brief' })
        .locator('.schedule__cron-time'),
    ).not.toHaveText('...');
    // archive#947: this Enter-submit was lost in ~2 of every 20 standalone runs — the
    // dialog just stayed open. Diagnosed rather than assumed: adding
    // `expect(saveChanges).toBeFocused()` immediately before the press still
    // failed at the same rate, and the failing run's trace shows *no*
    // `PUT /scheduler/jobs/weekly-brief` was ever issued. So the button was
    // focused and the keystroke still did not activate it — a re-render (the
    // cron editor's 400ms `setCronInput` debounce in JobFormModal, still
    // pending when this modal opens) lands between Enter's keydown and keyup
    // and the activation is dropped. A tight 30x focus+press loop on an
    // already-settled page never lost one, which matches that window.
    //
    // Retrying the keystroke rather than switching to `.click()` keeps the only
    // keyboard-submit coverage in this file. The assertion is unchanged — the
    // dialog must still close — and a repeat Enter after a successful save is a
    // no-op because the dialog is already gone.
    // `JobFormModal.tsx:191` titles it `Edit: <name>`. The old
    // `Edit job: weekly-brief` matched nothing, and `toBeHidden()` on a
    // zero-element locator passes — so this whole Enter-submit assertion was
    // asserting nothing.
    const editDialog = page.getByRole('dialog', {
      name: 'Edit: weekly-brief',
    });
    const saveChanges = page.getByRole('button', { name: 'Save Changes' });
    await expect(async () => {
      await saveChanges.press('Enter');
      await expect(editDialog).toBeHidden({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await expect(editDialog).toBeHidden();
    await page.getByTestId('job-row-weekly-brief').click();
    await expect(
      page.getByText('Summarize weekly work and risks'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Run weekly-brief' }).click();
    await expect.poll(() => runCalls).toEqual(['weekly-brief']);

    await page.getByTestId('job-row-weekly-brief').locator('td').nth(2).click();
    await expect(
      page
        .getByTestId('job-row-weekly-brief')
        .getByText('off', { exact: true }),
    ).toBeVisible();
    await page.getByTestId('job-row-weekly-brief').locator('td').nth(2).click();
    await expect(
      page.getByTestId('job-row-weekly-brief').getByText('on', { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Duplicate weekly-brief' }).click();
    await expect(page.getByPlaceholder('my-daily-briefing')).toHaveValue(
      'weekly-brief-copy',
    );
    await page.getByRole('button', { name: 'Add Job', exact: true }).click();
    await expect(page.getByTestId('job-row-weekly-brief-copy')).toBeVisible();

    await page
      .getByRole('button', { name: 'Delete weekly-brief-copy' })
      .click();
    await expect(page.getByRole('dialog')).toContainText(
      'Delete job "weekly-brief-copy"?',
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByTestId('job-row-weekly-brief-copy')).toHaveCount(0);
  });
});
