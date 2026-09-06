import type { Server } from 'node:http';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import type { StarterScheduledCheckObservation } from '@kontourai/station-contracts/starter-work';
import { expect, test } from './helpers/authenticated-request';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

const MODEL = 'station-clean-install:latest';
const USER_MESSAGE = 'Confirm this clean Station can complete real work.';
const FIXTURE_REPLY = 'Clean-install Station work completed.';
const STARTER_JOB = 'station-starter-check';

type ApiEnvelope<T> = { success: boolean; data: T };

test.use({ actionTimeout: 20_000 });

test('fresh Station completes real Work and reopens its exact Scheduler receipt', async ({
  authenticatedRequest,
  baseURL,
  page,
}) => {
  test.setTimeout(120_000);
  if (!baseURL)
    throw new Error('Starter clean-install suite requires a UI base URL');

  let ollamaServer: Server | null = null;
  const chatRequests: unknown[] = [];

  const readData = async <T>(path: string): Promise<T> => {
    const response = await authenticatedRequest.get(path);
    expect(response.ok(), `GET ${path}`).toBe(true);
    const body = (await response.json()) as ApiEnvelope<T>;
    expect(body.success, `GET ${path} success envelope`).toBe(true);
    return body.data;
  };

  try {
    const ollama = await startOllamaFixture(
      MODEL,
      (body) => chatRequests.push(body),
      FIXTURE_REPLY,
    );
    ollamaServer = ollama.server;

    await page.goto(baseURL);
    await expect(page.getByTestId('setup-launcher')).toBeVisible({
      timeout: 20_000,
    });

    await expect(readData<unknown[]>('/api/projects')).resolves.toEqual([]);
    await expect(readData<unknown[]>('/api/tasks')).resolves.toEqual([]);
    await expect(readData<SchedulerJob[]>('/scheduler/jobs')).resolves.toEqual(
      [],
    );
    await expect(
      readData<RunSummary[]>('/api/runs?source=schedule'),
    ).resolves.toEqual([]);

    await page.getByRole('button', { name: 'Continue Without Setup' }).click();
    const disclosure = page.getByTestId('first-run-disclosure');
    await expect(disclosure).toBeVisible({ timeout: 20_000 });
    // #1582 A3 renamed this action to the decision it makes; this spec still
    // clicked the acknowledgement that named neither choice, so it could not
    // reach the engine chapter at all.
    await disclosure
      .getByRole('button', { name: 'Keep usage telemetry on' })
      .click();
    const engineChapter = page.getByTestId('first-run-engines');
    await expect(engineChapter).toBeVisible({ timeout: 20_000 });
    await engineChapter.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByTestId('first-run-home-card')).toBeVisible();

    await page.getByRole('button', { name: /Set up an agent/i }).click();
    const newChat = page.getByRole('dialog', { name: 'New Chat' });
    await expect(newChat).toBeVisible();
    await newChat.getByRole('button', { name: 'Connect Station' }).click();
    await expect(newChat).toHaveCount(0);
    await expect(page).toHaveURL(/\/connections\/models(?:\?|$)/);
    await page.getByRole('button', { name: 'Add model connection' }).click();
    await expect(page).toHaveURL(/\/connections\/models\/new(?:\?|$)/);
    await page
      .locator('.provider-picker-modal')
      .getByRole('button', { name: /^Ollama/ })
      .first()
      .click();
    await page.getByLabel('Name').fill('Clean Install Ollama');
    await page.getByLabel('Base URL').fill(ollama.origin);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/connections\/models\/[^/?]+(?:\?|$)/);
    await page.getByRole('button', { name: 'Test Connection' }).click();
    await expect(page.getByText('Connection healthy')).toBeVisible();

    await expect
      .poll(async () => {
        const response = await authenticatedRequest.get('/api/system/status');
        const status = (await response.json()) as {
          providers?: { configuredChatReady?: boolean };
        };
        return status.providers?.configuredChatReady;
      })
      .toBe(true);

    await page.goto(baseURL);
    await page.getByRole('button', { name: 'Set up Station' }).click();
    const resumedEngines = page.getByTestId('first-run-engines');
    await expect(resumedEngines).toBeVisible({ timeout: 20_000 });
    await resumedEngines.getByRole('button', { name: 'Continue' }).click();
    await page
      .getByTestId('first-run-about-you')
      .getByRole('button', { name: 'Take the tour' })
      .click();
    await expect
      .poll(async () => {
        const config = await readData<{
          firstRun?: { status?: string };
        }>('/config/app');
        return config.firstRun?.status;
      })
      .toBe('completed');
    const completedConfig = await readData<{ telemetryEnabled?: boolean }>(
      '/config/app',
    );
    expect(completedConfig.telemetryEnabled).not.toBe(true);
    await page.getByRole('button', { name: 'Skip the tour' }).click();
    await page.getByRole('button', { name: 'Home', exact: true }).click();

    await expect(
      page.getByRole('button', { name: /Start direct chat/i }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Start direct chat/i }).click();
    const stationAgent = page.locator(
      '.new-chat-modal__agent[data-agent-slug="station"]',
    );
    await expect(stationAgent).toBeVisible({ timeout: 20_000 });
    await stationAgent.click();
    const composer = page.locator('textarea[placeholder*="Type a message"]');
    await expect(composer).toBeVisible();
    await composer.fill(USER_MESSAGE);
    // The real foreground route is the qualification boundary: a 409 here
    // means the UI must preserve the message as indeterminate rather than
    // sending it to Ollama. Assert its accepted receipt before accepting the
    // fixture's later stream, so this journey cannot misreport that branch as
    // a completed piece of Work.
    const foregroundResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/orchestration/chat' &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const dispatch = await foregroundResponse;
    expect(dispatch.status()).toBe(200);
    const receipt = (await dispatch.json()) as ApiEnvelope<{
      providerTurnId?: unknown;
    }>;
    expect(receipt.success).toBe(true);
    expect(receipt.data.providerTurnId).toEqual(expect.any(String));
    expect(receipt.data.providerTurnId).not.toBe('');
    await expect.poll(() => chatRequests.length).toBe(1);
    await expect(page.getByText(FIXTURE_REPLY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(chatRequests[0]).toMatchObject({
      model: MODEL,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining(USER_MESSAGE),
        }),
      ]),
    });

    await page.getByRole('button', { name: 'Home', exact: true }).click();
    const starter = page.getByRole('region', {
      name: 'Run a scheduled readiness check',
    });
    await expect(starter).toBeVisible();
    await starter.getByRole('button', { name: 'Run check' }).click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
      .toBe('/schedule');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('run'))
      .toMatch(/^schedule:built-in:station-starter-check:/);
    const exactRunId = new URL(page.url()).searchParams.get('run');
    expect(exactRunId).toBeTruthy();

    await expect
      .poll(async () => {
        const run = await readData<RunSummary>(
          `/api/runs/${encodeURIComponent(exactRunId!)}`,
        );
        return {
          runId: run.runId,
          source: run.source,
          sourceId: run.sourceId,
          status: run.status,
        };
      })
      .toEqual({
        runId: exactRunId,
        source: 'schedule',
        sourceId: STARTER_JOB,
        status: 'completed',
      });

    const observation = await readData<StarterScheduledCheckObservation>(
      '/api/starter-work/run-scheduled-check/observation',
    );
    expect(observation).toMatchObject({
      starterId: 'run-scheduled-check',
      receipt: { id: exactRunId, owner: 'scheduler-run' },
      href: `/schedule?run=${encodeURIComponent(exactRunId!)}`,
      completion: { state: 'completed' },
      evidence: { state: 'NOT_VERIFIED' },
    });
    const jobs = await readData<SchedulerJob[]>('/scheduler/jobs');
    expect(jobs).toEqual([
      expect.objectContaining({
        name: STARTER_JOB,
        provider: 'built-in',
        agent: 'station',
        enabled: false,
        retryCount: 0,
        schedule: { kind: 'every', everyMs: 86_400_000 },
      }),
    ]);
    await expect.poll(() => chatRequests.length).toBe(2);
    expect(chatRequests[1]).toMatchObject({
      model: MODEL,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringMatching(
            /current readiness[\s\S]*Do not change configuration or Work/,
          ),
        }),
      ]),
    });

    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.reload();
    const completedStarter = page.getByRole('region', {
      name: 'Run a scheduled readiness check',
    });
    await expect(completedStarter).toContainText(
      'evidence input, not a gate verdict',
    );
    await completedStarter
      .getByRole('button', { name: 'Open scheduled check' })
      .click();
    expect(new URL(page.url()).searchParams.get('run')).toBe(exactRunId);

    const focusedRun = page.locator(`[data-run-id="${exactRunId}"]`);
    await expect(focusedRun).toBeFocused({ timeout: 20_000 });
    await expect(
      focusedRun.getByText('Completed', { exact: true }),
    ).toBeVisible();
    await expect(focusedRun.getByText(/Passed|Verified/i)).toHaveCount(0);
    await focusedRun.getByRole('button', { name: 'Output' }).click();
    const output = page.getByRole('dialog', {
      name: `${STARTER_JOB} — Run Output`,
    });
    await expect(output).toContainText(FIXTURE_REPLY);
    await expect(
      output.getByText(/Passed|Verified|gate satisfied/i),
    ).toHaveCount(0);

    await expect(readData<unknown[]>('/api/projects')).resolves.toEqual([]);
    await expect(readData<unknown[]>('/api/tasks')).resolves.toEqual([]);
    await expect(
      readData<RunSummary[]>('/api/runs?source=schedule'),
    ).resolves.toHaveLength(1);
  } finally {
    await closeFixtureServer(ollamaServer);
  }
});
