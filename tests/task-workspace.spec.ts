import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoBlockingAccessibilityViolations } from './helpers/accessibility';
import { waitForVisibleAnswerThroughCapacityRetry } from './helpers/capacity-retry';
import {
  allocateLiveStation,
  apiJson,
  createProject,
  createRepository,
  createTaskFromProject,
  gitTopLevel,
  type LiveStation,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import {
  closeFixtureServer,
  startOllamaFixture,
} from './helpers/ollama-fixture';

test.describe
  .serial('Durable Task experience live acceptance (#496, #495)', () => {
    test.setTimeout(180_000);

    let live: LiveStation;
    let fixtureRoot: string;
    let uiBootstrapToken: string;
    let ollamaServer: Server | null = null;

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      // startStation worst case (concurrent readiness) = runCommand(120s) +
      // one readiness deadline (60s) = 180s; set the hook budget to 240s so
      // it strictly dominates the nested waits with clear margin. Sequential
      // readiness was an impossible 240s sum (120s + 60s + 60s) the old 180s
      // budget hid.
      testInfo.setTimeout(240_000);
      fixtureRoot = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
      live = await allocateLiveStation('station-task-home-', 'task-workspace');
      uiBootstrapToken = await startStation(live, true);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      // stopStation runs a 120s-bounded ./station stop; give the hook room.
      testInfo.setTimeout(180_000);
      let stopError: unknown;
      if (live) {
        try {
          await stopStation(live);
        } catch (error) {
          stopError = error;
        }
      }
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
      await closeFixtureServer(ollamaServer);
      ollamaServer = null;
      if (live?.home && !stopError) {
        rmSync(live.home, { recursive: true, force: true });
      }
      if (stopError) {
        throw new Error(
          `Failed to stop isolated Station instance ${live.instance}; preserved diagnostic home ${live.home}`,
          { cause: stopError },
        );
      }
    });

    test('creates, restores, and switches durable Task workspaces with honest optional experiences', async ({
      page,
    }, testInfo) => {
      testInfo.setTimeout(180_000);
      await page.goto(`${live.ui}/#station-ui-bootstrap=${uiBootstrapToken}`);
      await expect(
        page.getByRole('region', { name: 'Station access required' }),
      ).toHaveCount(0);
      const primaryRepo = join(fixtureRoot, 'primary-worktree');
      const secondaryRepo = join(fixtureRoot, 'secondary-worktree');
      await createRepository(primaryRepo, 'task-primary');
      await createRepository(secondaryRepo, 'task-secondary');
      const primaryGitTopLevel = await gitTopLevel(primaryRepo);
      const secondaryGitTopLevel = await gitTopLevel(secondaryRepo);
      writeFileSync(join(primaryRepo, 'artifact.md'), 'artifact evidence\n');
      writeFileSync(join(primaryRepo, 'receipt.md'), 'receipt evidence\n');
      writeFileSync(join(primaryRepo, 'local.md'), 'local file evidence\n');
      writeFileSync(
        join(primaryRepo, 'README.md'),
        'baseline\nwhole worktree diff\n',
      );

      await page.goto(live.ui);
      await createProject(page, 'primary-task-project', primaryRepo);
      const primaryTaskId = await createTaskFromProject(
        page,
        live,
        'primary-task-project',
        'Primary durable Task',
        primaryRepo,
        'task-primary',
      );

      const graph = await apiJson<{ success: boolean; data: { task: any } }>(
        page,
        `/api/tasks/${encodeURIComponent(primaryTaskId)}/graph`,
      );
      expect(graph.success).toBe(true);
      expect(graph.data.task.workspaceBinding).toMatchObject({
        workingDirectory: primaryGitTopLevel,
        repoRoot: primaryGitTopLevel,
        worktreePath: primaryGitTopLevel,
        branch: 'task-primary',
        sourceSurface: 'ui',
      });

      for (const [kind, path] of [
        ['artifact', 'artifact.md'],
        ['receipt', 'receipt.md'],
      ] as const) {
        const result = await apiJson<{ success: boolean }>(
          page,
          `/api/tasks/${encodeURIComponent(primaryTaskId)}/references`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, targetId: path, metadata: { path } }),
          },
        );
        expect(result.success).toBe(true);
      }
      for (const [targetId, metadata] of [
        [
          'https://attacker.example/work-items/42',
          {
            experience: 'deliver',
            href: 'https://attacker.example/phishing',
            lifecycle: 'complete',
          },
        ],
        [
          `knowledge://record/${primaryTaskId}`,
          { experience: 'learn', freshness: 'fresh' },
        ],
        [
          `https://console.example.test/tasks/${primaryTaskId}`,
          { experience: 'operate', operatingState: 'healthy' },
        ],
      ] as const) {
        const result = await apiJson<{ success: boolean }>(
          page,
          `/api/tasks/${encodeURIComponent(primaryTaskId)}/references`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'external', targetId, metadata }),
          },
        );
        expect(result.success).toBe(true);
      }
      const dispatch = await apiJson<{ success: boolean }>(
        page,
        `/api/tasks/${encodeURIComponent(primaryTaskId)}/dispatch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relatedFiles: ['local.md'],
            sourceSurface: 'ui',
          }),
        },
      );
      expect(dispatch.success).toBe(true);

      await page.goto(`${live.ui}/tasks/${encodeURIComponent(primaryTaskId)}`);
      await expect(
        page.getByText(primaryGitTopLevel, { exact: true }),
      ).toHaveCount(3);
      await expect(
        page.getByText('task-primary', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: /artifact.md/ }).click();
      await expect(page.getByText('artifact evidence')).toBeVisible();
      await page.getByRole('button', { name: /local.md/ }).click();
      await expect(page.getByText('local file evidence')).toBeVisible();
      const keepLocalOutput = page.getByRole('button', {
        name: 'Keep local.md as output',
      });
      await keepLocalOutput.click();
      await expect(
        page.getByText('Kept “local.md” as an immutable Task output.'),
      ).toBeVisible();
      await expect(
        page
          .getByRole('list', { name: 'Task outputs' })
          .getByText(/^sha256:[a-f0-9]{64}$/),
      ).toBeVisible();
      // The output is a snapshot, not a pointer back into the worktree.
      writeFileSync(join(primaryRepo, 'local.md'), 'changed after promotion\n');
      rmSync(join(primaryRepo, 'local.md'));
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).resolves.toBe(true);
      const deleteLocalOutput = page.getByRole('button', {
        name: 'Delete output local.md',
      });
      await deleteLocalOutput.click();
      const deleteOutputDialog = page.getByRole('alertdialog', {
        name: 'Delete “local.md”?',
      });
      const deleteOutputConfirmation = deleteOutputDialog.getByRole('textbox', {
        name: 'Confirm deletion of local.md',
      });
      await expect(deleteOutputConfirmation).toBeFocused();
      await deleteOutputConfirmation.press('Escape');
      await expect(deleteOutputDialog).toHaveCount(0);
      await expect(deleteLocalOutput).toBeFocused();
      await expectNoBlockingAccessibilityViolations(
        page,
        'task-outputs',
        '.task-outputs',
      );
      // The remaining Task-workspace assertions exercise the desktop surface.
      // Mobile output acceptance is complete above.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: /receipt.md/ }).click();
      await expect(page.getByText('receipt evidence')).toBeVisible();
      await page.getByRole('button', { name: 'Inspect worktree diff' }).click();
      await expect(page.getByText('whole worktree diff')).toBeVisible();
      await expect(
        page.getByText('Optional integrations not attached'),
      ).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Task inspection' }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Add capabilities' }),
      ).toHaveAttribute('href', '/plugins');
      await expect(
        page.getByText(/Inspection is not a verification claim/i),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /attacker\.example/i }),
      ).toBeVisible();

      await expect(
        page.getByRole('button', { name: /Builder Kit|Knowledge Kit|Console/ }),
      ).toHaveCount(0);
      await expect(page.getByText('Local references')).toBeVisible();

      await createProject(page, 'secondary-task-project', secondaryRepo);
      const secondaryTaskId = await createTaskFromProject(
        page,
        live,
        'secondary-task-project',
        'Secondary durable Task',
        secondaryRepo,
        'task-secondary',
      );
      await expect(
        page.getByText(secondaryGitTopLevel, { exact: true }),
      ).toHaveCount(3);
      await expect(
        page.getByText('task-secondary', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(
        2,
      );
      await expect(page.getByText('References not recorded yet')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Task inspection' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Builder Kit|Knowledge Kit|Console/ }),
      ).toHaveCount(0);
      expect(page.url()).toContain(
        `/tasks/${encodeURIComponent(secondaryTaskId)}`,
      );
      await expect(page.getByText('artifact.md', { exact: true })).toHaveCount(
        0,
      );

      await page.goto(`${live.ui}/tasks/${encodeURIComponent(primaryTaskId)}`);
      await expect(
        page.getByRole('heading', { name: 'Task inspection' }),
      ).toBeVisible();
      await expect(
        page.getByText('artifact.md', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText(secondaryRepo, { exact: true })).toHaveCount(
        0,
      );

      await stopStation(live);
      await startStation(live, false);
      await page.goto(`${live.ui}/tasks/${encodeURIComponent(primaryTaskId)}`);
      await expect(
        page.getByText(primaryGitTopLevel, { exact: true }),
      ).toHaveCount(3);
      await expect(
        page.getByText('artifact.md', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: /artifact.md/ }).click();
      await expect(page.getByText('artifact evidence')).toBeVisible();
      await page.getByRole('button', { name: 'View output local.md' }).click();
      await expect(page.getByLabel('Preview of output local.md')).toContainText(
        'local file evidence',
      );
      await page.screenshot({
        path: testInfo.outputPath('durable-task-workspace.png'),
        fullPage: true,
      });
    });

    test('pins a real completed project answer through the keyboard-safe basis UI and reopens it after restart', async ({
      page,
    }, testInfo) => {
      testInfo.setTimeout(180_000);
      const answer = 'The fixture produced this public Task basis answer.';
      const projectSlug = `answer-basis-${Date.now()}`;
      const taskTitle = 'Exact answer basis Task';
      const agentSlug = `answer-basis-agent-${Date.now()}`;
      const agentName = 'Answer basis fixture Agent';
      const modelConnectionId = `answer-basis-ollama-${Date.now()}`;
      const repo = join(fixtureRoot, 'answer-basis-project');

      await page.goto(`${live.ui}/#station-ui-bootstrap=${uiBootstrapToken}`);
      await createRepository(repo, 'answer-basis');
      await createProject(page, projectSlug, repo);
      const taskId = await createTaskFromProject(
        page,
        live,
        projectSlug,
        taskTitle,
        repo,
        'answer-basis',
      );

      const fixture = await startOllamaFixture(
        'answer-basis:latest',
        () => undefined,
        answer,
      );
      ollamaServer = fixture.server;
      const connection = await apiJson<{ success: boolean; error?: string }>(
        page,
        '/api/connections',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modelConnectionId,
            kind: 'model',
            type: 'ollama',
            name: 'Answer basis model fixture',
            enabled: true,
            capabilities: ['llm'],
            config: { baseUrl: fixture.origin, defaultModel: fixture.model },
            status: 'ready',
            prerequisites: [],
          }),
        },
      );
      expect(connection, connection.error).toMatchObject({ success: true });
      const agent = await apiJson<{ success: boolean; error?: string }>(
        page,
        '/agents',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: agentSlug,
            name: agentName,
            prompt: 'Answer in one short public sentence.',
          }),
        },
      );
      expect(agent, agent.error).toMatchObject({ success: true });
      await expect
        .poll(
          async () => {
            const catalog = await apiJson<{
              data?: Array<{ slug?: string }>;
              catalogState?: string;
            }>(page, '/api/agents');
            return (
              catalog.catalogState !== 'reconciling' &&
              catalog.data?.some((candidate) => candidate.slug === agentSlug)
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      // Starting from the project keeps the real generated Session scoped to
      // the same Project as the Task. This is the browser path that exercises
      // the server-side project/session matching guard.
      await page.goto(`${live.ui}/projects/${projectSlug}?dock=open`);
      await expect(
        page
          .getByRole('button', { name: /^Manage Stations/ })
          .getByLabel('connected'),
      ).toBeVisible({ timeout: 30_000 });
      const newChat = page.getByTitle(/^New Chat/);
      await expect(newChat).toBeVisible({ timeout: 20_000 });
      await newChat.click();
      // Chromium can paint this lazy route-transition dialog before its role
      // is reflected in the accessibility snapshot. Keep the semantic DOM
      // contract exact while avoiding that transient accessibility-tree race.
      const picker = page.locator(
        '.new-chat-modal[role="dialog"][aria-label="New Chat"]',
      );
      await expect(picker).toBeVisible();
      await picker.getByRole('button', { name: new RegExp(agentName) }).click();
      const composer = page.getByPlaceholder('Type a message...');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await composer.fill('Give me the public answer.');
      await composer.press('Enter');
      await waitForVisibleAnswerThroughCapacityRetry(page, answer);

      const addToTask = page.getByRole('button', {
        name: /Add this answer to a Task/,
      });
      await expect(addToTask).toBeVisible();
      const addLabel = await addToTask.getAttribute('aria-label');
      const turnId = addLabel?.match(/\(turn (.+)\)$/)?.[1];
      expect(turnId).toBeTruthy();
      const sessions = await apiJson<{
        success: boolean;
        data: Array<{ threadId?: string; id?: string }>;
      }>(page, '/api/orchestration/sessions');
      const sessionIds = sessions.data
        .map((session) => session.threadId ?? session.id)
        .filter((id): id is string => Boolean(id));
      const sessionId = await page.evaluate(
        async ({ candidates, sourceTurnId }) => {
          for (const candidate of candidates) {
            const response = await fetch(
              `/api/orchestration/sessions/${encodeURIComponent(candidate)}/turns/${encodeURIComponent(sourceTurnId)}`,
            );
            if (response.ok) return candidate;
          }
          return undefined;
        },
        { candidates: sessionIds, sourceTurnId: turnId! },
      );
      expect(sessionId).toBeTruthy();

      // A real source tuple must not be attachable to a Task in another
      // Project. Do this through the live API, then verify the foreign Task
      // retained no reference before exercising the allowed browser path.
      const foreignSlug = `answer-basis-foreign-${Date.now()}`;
      const foreignRepo = join(fixtureRoot, 'answer-basis-foreign-project');
      await createRepository(foreignRepo, 'answer-basis-foreign');
      await createProject(page, foreignSlug, foreignRepo);
      const foreignTask = await apiJson<{
        success: boolean;
        data: { id: string };
      }>(page, '/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: foreignSlug, title: 'Foreign Task' }),
      });
      expect(foreignTask.success).toBe(true);
      const foreignAttempt = await page.evaluate(
        async ({ taskId, sourceSessionId, sourceTurnId }) => {
          const response = await fetch(
            `/api/tasks/${encodeURIComponent(taskId)}/references`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                kind: 'turn',
                sessionId: sourceSessionId,
                turnId: sourceTurnId,
              }),
            },
          );
          return { status: response.status, body: await response.json() };
        },
        {
          taskId: foreignTask.data.id,
          sourceSessionId: sessionId!,
          sourceTurnId: turnId!,
        },
      );
      expect(foreignAttempt).toEqual({
        status: 404,
        body: { success: false, error: 'Assistant answer not found' },
      });
      const foreignReferences = await apiJson<{
        success: boolean;
        data: unknown[];
      }>(
        page,
        `/api/tasks/${encodeURIComponent(foreignTask.data.id)}/turn-references`,
      );
      expect(foreignReferences).toEqual({ success: true, data: [] });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).resolves.toBe(true);
      await addToTask.click();
      const attachDialog = page.getByRole('dialog', {
        name: 'Add answer to Task',
      });
      const search = attachDialog.getByRole('searchbox', {
        name: 'Find a Task',
      });
      await search.focus();
      await expect(search).toBeFocused();
      await expect(
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).resolves.toBe(true);
      await expectNoBlockingAccessibilityViolations(
        page,
        'task-answer-basis-dialog',
        '[role="dialog"]',
      );
      await search.press('Escape');
      await expect(attachDialog).toHaveCount(0);
      await expect(addToTask).toBeFocused();

      await addToTask.press('Enter');
      await expect(attachDialog).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();
      await search.fill(taskTitle);
      const exactTask = attachDialog.getByRole('button', {
        name: new RegExp(taskTitle),
      });
      await exactTask.focus();
      await exactTask.press('Enter');
      await expect(exactTask).toHaveAttribute('aria-pressed', 'true');
      const confirm = attachDialog.getByRole('button', {
        name: 'Add answer',
        exact: true,
      });
      await confirm.focus();
      await confirm.press('Enter');
      await expect(attachDialog).toHaveCount(0);

      await page.goto(`${live.ui}/tasks/${encodeURIComponent(taskId)}`);
      await expect(
        page.getByRole('heading', { name: 'Answer basis', exact: true }),
      ).toBeVisible();
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
      await expect(
        page.getByText(/Semantic support was not assessed/),
      ).toBeVisible();
      await expect(page.getByText(/reasoning/i)).toHaveCount(0);
      await expectNoBlockingAccessibilityViolations(
        page,
        'task-answer-basis',
        '.task-workspace__answer-basis',
      );

      await stopStation(live);
      uiBootstrapToken = await startStation(live, false);
      await page.goto(`${live.ui}/#station-ui-bootstrap=${uiBootstrapToken}`);
      await page.goto(`${live.ui}/tasks/${encodeURIComponent(taskId)}`);
      await expect(page.getByText(answer, { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      await expect(
        page.getByRole('heading', { name: 'Answer basis', exact: true }),
      ).toBeVisible();
      await expect(
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).resolves.toBe(true);
    });
  });
