import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { claudeAttachedThreadId } from '../src-server/providers/sessions/claude-transcript-session-source.js';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

const API = resolveE2EApiBase();
const PROJECT_SLUG = 'external-session-follow-e2e';
const EXTERNAL_SESSION_ID = 'claude-terminal-follow-e2e';
const THREAD_ID = claudeAttachedThreadId(EXTERNAL_SESSION_ID);
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

let workspaceDir: string;
let transcriptPath: string;

const ATTACHED_MOBILE_THREAD_ID = 'external:claude:terminal-mobile';
const ADOPTED_MOBILE_THREAD_ID = 'station-child-mobile';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function deleteProject(): Promise<void> {
  await authenticatedE2EFetch(`${API}/api/projects/${PROJECT_SLUG}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}

async function waitForAttachedSession(): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await authenticatedE2EFetch(
          `${API}/api/orchestration/session-board/projects/${PROJECT_SLUG}`,
        );
        const result = (await response.json()) as {
          success?: boolean;
          data?: Array<{ sessionId?: string; controlMode?: string }>;
        };
        return result.data?.find((item) => item.sessionId === THREAD_ID)
          ?.controlMode;
      },
      { timeout: 15_000 },
    )
    .toBe('read-only-attached');
}

async function mockMobileAdoption(page: Page) {
  const source = {
    threadId: ATTACHED_MOBILE_THREAD_ID,
    provider: 'claude',
    controlMode: 'read-only-attached',
    status: 'ready',
    lifecycleState: 'needs_input',
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    projectSlug: 'dev',
  };
  const child = {
    ...source,
    threadId: ADOPTED_MOBILE_THREAD_ID,
    controlMode: 'station-owned',
    delegation: {
      taskId: 'task:station-child-mobile',
      environmentId: 'env-current',
      environmentName: 'Current environment',
      projectSlug: 'dev',
      mode: 'isolated-child',
    },
    eventCount: 0,
    createdAt: '2026-07-22T12:01:00.000Z',
    updatedAt: '2026-07-22T12:01:00.000Z',
  };
  let sessions = [source];
  let listRequests = 0;
  let flowRequests = 0;
  const commands: Array<Record<string, unknown>> = [];

  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await page.route('**/api/projects/dev/workflow/tasks', (route) =>
    route.fulfill({
      json: { success: true, data: [] },
    }),
  );
  await page.route('**/api/orchestration/sessions/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/orchestration/sessions/read-model') {
      listRequests += 1;
      return route.fulfill({
        json: { success: true, data: sessions },
      });
    }
    if (
      path ===
      `/api/orchestration/sessions/${ADOPTED_MOBILE_THREAD_ID}/flow-run`
    ) {
      flowRequests += 1;
      const verifying = flowRequests > 1;
      return route.fulfill({
        json: {
          success: true,
          data: {
            runId: 'run-adopted-mobile',
            definitionId: 'station-delivery',
            cwd: '/tmp/dev',
            run: {
              runId: 'run-adopted-mobile',
              dir: '/tmp/dev/.kontourai/flow/runs/run-adopted-mobile',
              definition: {},
              state: {
                status: 'running',
                current_step: verifying ? 'verify' : 'execute',
              },
              manifest: {},
              openGates: [
                {
                  id: verifying ? 'acceptance' : 'execute-gate',
                  step: verifying ? 'verify' : 'execute',
                },
              ],
            },
          },
        },
      });
    }
    const threadId = decodeURIComponent(path.split('/').at(-1) ?? '');
    const session = sessions.find(
      (candidate) => candidate.threadId === threadId,
    );
    return route.fulfill({
      status: session ? 200 : 404,
      json: session
        ? { success: true, data: { session, events: [] } }
        : { success: false, error: 'Session not found' },
    });
  });
  await page.route('**/api/orchestration/commands', (route) => {
    const command = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(command);
    if (command.type === 'adoptSession') {
      sessions = [source, child];
      return route.fulfill({
        status: 201,
        json: { success: true, data: child },
      });
    }
    return route.fulfill({
      status: 400,
      json: { success: false, error: 'Unexpected command' },
    });
  });

  return {
    commands,
    flowRequestCount: () => flowRequests,
    listRequestCount: () => listRequests,
  };
}

test.describe
  .serial('External Claude terminal session follow', () => {
    test.beforeAll(async () => {
      if (!claudeConfigDir) {
        throw new Error(
          'CLAUDE_CONFIG_DIR is required so this E2E uses an isolated transcript root.',
        );
      }

      workspaceDir = mkdtempSync(join(tmpdir(), 'station-external-session-'));
      const transcriptDirectory = join(
        claudeConfigDir,
        'projects',
        'external-session-e2e',
      );
      mkdirSync(transcriptDirectory, { recursive: true });
      transcriptPath = join(
        transcriptDirectory,
        `${EXTERNAL_SESSION_ID}.jsonl`,
      );

      await deleteProject();
      const response = await authenticatedE2EFetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'External Session Follow E2E',
          slug: PROJECT_SLUG,
          workingDirectory: workspaceDir,
        }),
      });
      const result = (await response.json()) as { success?: boolean };
      expect(response.ok).toBe(true);
      expect(result.success).toBe(true);
    });

    test.afterAll(async () => {
      await deleteProject();
      if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
    });

    test('discovers, opens, and follows a terminal transcript without exposing mutation controls', async ({
      page,
    }) => {
      // The server is already running before this file appears: discovery must
      // follow a newly-created external transcript rather than bootstrap state.
      writeFileSync(
        transcriptPath,
        [
          {
            type: 'user',
            uuid: 'user-initial',
            sessionId: EXTERNAL_SESSION_ID,
            cwd: workspaceDir,
            timestamp: '2026-07-22T12:00:00.000Z',
            message: { role: 'user', content: 'Inspect the workspace' },
          },
          {
            type: 'assistant',
            uuid: 'assistant-initial',
            sessionId: EXTERNAL_SESSION_ID,
            timestamp: '2026-07-22T12:00:01.000Z',
            message: {
              content: [{ type: 'text', text: 'The workspace is ready.' }],
            },
          },
        ]
          .map(jsonl)
          .join(''),
      );

      await waitForAttachedSession();

      // The project board is the Console work-item projection now; attached
      // runtime sessions live on the provider-neutral Sessions surface.
      await page.goto(`/activity?session=${encodeURIComponent(THREAD_ID)}`);
      await expect(page).toHaveURL(
        new RegExp(`/activity\\?session=${encodeURIComponent(THREAD_ID)}$`),
      );

      const detail = page.getByTestId('session-detail');
      await expect(detail).toContainText(
        'Following terminal session · Read only',
      );
      await expect(detail).toContainText('Inspect the workspace');
      await expect(detail).toContainText('The workspace is ready.');
      await expect(
        page.getByTestId('attached-session-transcript'),
      ).toBeVisible();

      const rejection = await authenticatedE2EFetch(
        `${API}/api/orchestration/sessions/${encodeURIComponent(THREAD_ID)}/lifecycle`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: 'blocked',
            reason: 'manual_update',
            message: 'Try to take over',
          }),
        },
      );
      expect(rejection.status).toBe(400);
      await expect(rejection.json()).resolves.toMatchObject({
        success: false,
        error: 'Attached sessions are read-only.',
      });

      const urlBeforeAppend = page.url();
      appendFileSync(
        transcriptPath,
        [
          {
            type: 'user',
            uuid: 'user-appended',
            sessionId: EXTERNAL_SESSION_ID,
            cwd: workspaceDir,
            timestamp: '2026-07-22T12:00:02.000Z',
            message: { role: 'user', content: 'What changed?' },
          },
          {
            type: 'assistant',
            uuid: 'assistant-appended',
            sessionId: EXTERNAL_SESSION_ID,
            timestamp: '2026-07-22T12:00:03.000Z',
            message: {
              content: [
                { type: 'text', text: 'The appended turn is visible.' },
              ],
            },
          },
        ]
          .map(jsonl)
          .join(''),
      );

      await expect(detail).toContainText('The appended turn is visible.', {
        timeout: 15_000,
      });
      expect(page.url()).toBe(urlBeforeAppend);

      await page.setViewportSize({ width: 320, height: 720 });
      await expect(detail).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: /send|approve|decline|stop|resume|retry|delegate/i,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Continue in Station' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  });

test('adopts an attached session into a linked Flow child without reopening after mobile Back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const fixture = await mockMobileAdoption(page);

  await page.goto(
    `/activity?session=${encodeURIComponent(ATTACHED_MOBILE_THREAD_ID)}`,
  );
  const detail = page.getByTestId('session-detail');
  await expect(detail).toContainText('Following terminal session · Read only');
  const continueButton = page.getByRole('button', {
    name: 'Continue in Station',
  });
  await continueButton.scrollIntoViewIfNeeded();
  await expect(continueButton).toBeInViewport();
  expect((await continueButton.boundingBox())?.width).toBeLessThanOrEqual(304);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await continueButton.click();
  // Exactly one adopt, for the followed thread. The command now also carries a
  // per-intent `idempotencyKey` (`packages/sdk/src/query-domains/
  // chatRuntimeOrchestration.ts:314-342`), whose same-intent/new-intent
  // semantics are owned a layer down by
  // `packages/sdk/src/__tests__/adoptOrchestrationSession.test.ts:157-180`.
  // Asserting it is a string keeps this red if it is ever dropped from the wire
  // without re-asserting a shape this test does not own.
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toMatchObject({
    type: 'adoptSession',
    sourceThreadId: ATTACHED_MOBILE_THREAD_ID,
  });
  expect(fixture.commands[0]?.idempotencyKey).toEqual(expect.any(String));
  await expect(detail).toContainText(ADOPTED_MOBILE_THREAD_ID);
  await expect(page.getByLabel('Continue delegated task')).toBeVisible();

  await expect(detail.getByText('Linked Flow')).toBeVisible();
  await expect(detail.getByText('execute · gates: execute-gate')).toBeVisible();
  await expect
    .poll(fixture.flowRequestCount, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(detail.getByText('verify · gates: acceptance')).toBeVisible();

  const back = page.getByRole('button', { name: /Back to list/ });
  await back.click();
  await expect(detail).toHaveCount(0);
  const requestsAfterBack = fixture.listRequestCount();
  await expect
    .poll(fixture.listRequestCount, { timeout: 7_000 })
    .toBeGreaterThan(requestsAfterBack);
  await expect(detail).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
